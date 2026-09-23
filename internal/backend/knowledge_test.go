package backend

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestReferenceSnapshotsAreDataOnly(t *testing.T) {
	catalog, err := loadReferenceCatalogs()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.BooksByID) != len(catalog.Books) || catalog.BooksByID["book_beng"] == nil {
		t.Fatal("book identities were lost")
	}
	for kind, items := range map[string][]Object{"milestones": catalog.Milestones, "activities": catalog.Activities, "warningSigns": catalog.WarningSigns} {
		for _, item := range items {
			value, err := developmentProjection(kind, item)
			if err != nil || !reflect.DeepEqual(value["details"], item) {
				t.Fatalf("invalid %s item %v: %v", kind, item["id"], err)
			}
		}
	}
	for _, source := range []string{
		`export const books: unknown[] = loadRemote();`,
		`export const other: unknown[] = [];`,
		`export const books: unknown[] = []; export const books: unknown[] = [];`,
		`export const books: unknown[] = []; console.log("not data");`,
		`export const books: unknown[] = []`,
	} {
		var values []Object
		if decodeReferenceLiteral([]byte(source), "books", &values) == nil {
			t.Fatalf("accepted a non-data snapshot: %q", source)
		}
	}
}

func TestDevelopmentProjectionDoesNotExposeOrMutateRootExtras(t *testing.T) {
	item := Object{"id": "test_milestone", "monthAge": json.Number("2"), "category": "test_category", "title": "test_title", "description": "test_description", "extra": Object{"source": "test_original"}}
	got, err := developmentProjection("milestones", item)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 7 || got["extra"] != nil {
		t.Fatalf("root projection differs: %v", got)
	}
	obj(obj(got["details"])["extra"])["source"] = "test_changed"
	if obj(item["extra"])["source"] != "test_original" {
		t.Fatal("response mutation changed the shared reference")
	}
}

func TestNativeKnowledgeFilteringAndPublicConfiguration(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.registerKnowledge()
	if !s.Public["getAppConfig"] || s.Public["listMilestones"] || s.Public["listActivities"] || s.Public["listWarningSigns"] {
		t.Fatal("knowledge authentication boundary changed")
	}
	for _, flag := range []string{"", "1", "true", "0"} {
		t.Setenv("SW_DISABLED", flag)
		result, err := s.Handlers["getAppConfig"](context.Background(), &Request{})
		if err != nil || boolean(obj(obj(obj(result.Body)["data"])["features"])["swDisabled"]) != (flag == "1") {
			t.Fatalf("configuration mismatch for %q: %v", flag, err)
		}
	}
	for _, tc := range []struct{ operation, path string; empty bool }{
		{"listMilestones", "/api/v1/development/milestones?month=2", false},
		{"listMilestones", "/api/v1/development/milestones?category=test_missing", true},
		{"listActivities", "/api/v1/development/activities", false},
		{"listWarningSigns", "/api/v1/development/warning-signs", false},
	} {
		result, err := s.Handlers[tc.operation](context.Background(), &Request{HTTP: httptest.NewRequest("GET", tc.path, nil)})
		if err != nil {
			t.Fatal(err)
		}
		body := obj(result.Body)
		values, ok := body["data"].([]Object)
		if !ok || (len(values) == 0) != tc.empty {
			t.Fatalf("filter mismatch for %s", tc.path)
		}
		if (body["dataRelease"] != nil) != (tc.operation == "listMilestones") {
			t.Fatal("release metadata projection differs")
		}
		if tc.operation == "listMilestones" && !tc.empty {
			for _, value := range values {
				if integer(value["monthAge"]) != 2 {
					t.Fatal("month filter ignored")
				}
			}
		}
	}
}

func TestBookProjectionPreservesReadingResponseVariants(t *testing.T) {
	book := Object{"id": "test_book", "title": "test_title", "categories": []any{"test_category"}, "nested": Object{"test": true}}
	initial, err := bookDTO(book, nil, false)
	if err != nil || initial["status"] != "unread" || initial["version"] != "0" || initial["category"] != "test_category" {
		t.Fatalf("initial reading projection: %v %v", initial, err)
	}
	state := Object{"status": "finished", "is_favorite": true, "read_count": json.Number("3"), "version": json.Number("2")}
	list, err := bookDTO(book, state, false)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := bookDTO(book, state, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := obj(list["details"])["status"]; exists || obj(updated["details"])["status"] != "finished" {
		t.Fatal("list and mutation details.status must remain distinct")
	}
	obj(obj(updated["details"])["nested"])["test"] = false
	if !boolean(obj(book["nested"])["test"]) {
		t.Fatal("book projection mutated reference data")
	}
}

func TestBookPatchPrecedenceAndZeroValues(t *testing.T) {
	previous := Object{"status": "reading", "is_favorite": true, "read_count": json.Number("4")}
	for _, tc := range []struct{ patch Object; status string; favorite bool; count int64 }{
		{Object{"isFavorite": false}, "reading", false, 4},
		{Object{"readCount": json.Number("0")}, "unread", true, 0},
		{Object{"readCount": json.Number("1")}, "finished", true, 1},
		{Object{"readCount": json.Number("1"), "status": "reading"}, "reading", true, 1},
	} {
		status, favorite, count, err := bookPatchState(previous, tc.patch)
		if err != nil || status != tc.status || favorite != tc.favorite || count != tc.count {
			t.Fatalf("patch %v: %s %t %d %v", tc.patch, status, favorite, count, err)
		}
	}
	if _, _, _, err := bookPatchState(previous, Object{"readCount": json.Number("2147483648")}); err == nil {
		t.Fatal("out-of-range count must not silently become zero")
	}
	if integer(previous["read_count"]) != 4 || previous["status"] != "reading" {
		t.Fatal("patch mutated its previous input")
	}
}
