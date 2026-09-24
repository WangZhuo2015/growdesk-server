package backend

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

const testUUID = "00000000-0000-4000-8000-000000000001"
const testTime = "2026-05-02T03:04:05.000Z"

func TestNativeDomainRegistration(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.RegisterBusinessHandlers()
	for _, id := range []string{"listFamilies", "createFamily", "getFamily", "updateFamily", "createFamilyInvite", "previewFamilyInvite", "joinFamily", "listFamilyMembers", "updateFamilyMember", "removeFamilyMember", "listFamilyBabies", "createFamilyBaby", "getBaby", "updateBaby", "listBabyMembers", "addBabyMember", "removeBabyMember", "getTimeline"} {
		if s.Handlers[id] == nil {
			t.Errorf("native handler missing: %s", id)
		}
		if s.Public[id] != (id == "previewFamilyInvite") {
			t.Errorf("public auth policy mismatch: %s", id)
		}
	}
	for _, spec := range careSpecs {
		for _, prefix := range []string{"create", "get", "update", "delete", "list"} {
			id := prefix + spec.OperationName
			if prefix == "list" {
				id += "s"
			}
			if s.Handlers[id] == nil {
				t.Errorf("missing %s", id)
			}
		}
	}
	if s.Handlers["createAiRun"] == nil || s.Public["createAiRun"] {
		t.Fatal("createAiRun must be registered and authenticated")
	}
}

func TestDomainResponseContracts(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	family := familyDTO(Object{"id": testUUID, "name": "test_family", "timezone": "Asia/Tokyo", "created_at": testTime, "updated_at": testTime})
	baby := babyDTO(Object{"id": testUUID, "family_id": testUUID, "nickname": "test_baby", "birth_date": "2026-01-01", "gender": "female", "created_at": testTime, "updated_at": testTime})
	cases := []struct {
		id     string
		status int
		body   any
	}{
		{"createFamily", 201, envelope(family)}, {"listFamilies", 200, envelope([]Object{family})},
		{"createFamilyBaby", 201, envelope(baby)}, {"listFamilyBabies", 200, envelope([]Object{})},
		{"addBabyMember", 201, success()}, {"removeBabyMember", 200, envelope(Object{"removed": true})},
	}
	for _, d := range careSpecs {
		entity := Object{"id": testUUID, "babyId": testUUID, "familyId": testUUID, "version": int64(1), "createdAt": testTime, "updatedAt": testTime,
			"source": "ui_manual", "sourceAgent": nil, "recordedByUserId": testUUID}
		for _, f := range d.Fields {
			entity[f.Wire] = nil
		}
		switch d.Kind {
		case "feeding":
			entity["feedingType"] = "formula"
			entity["occurredAt"] = testTime
			entity["spitUp"] = "false"
			entity["amountMl"] = "0"
		case "sleep":
			entity["sleepType"] = "nap"
			entity["startedAt"] = testTime
			entity["nightWakingCount"] = int64(0)
		case "diaper":
			entity["diaperType"] = "pee"
			entity["occurredAt"] = testTime
		}
		result, e := careMutationResult(d, "create", entity)
		if e != nil {
			t.Fatal(e)
		}
		cases = append(cases, struct {
			id     string
			status int
			body   any
		}{"create" + d.OperationName, 201, result.Body})
		result, e = careMutationResult(d, "delete", entity)
		if e != nil {
			t.Fatal(e)
		}
		cases = append(cases, struct {
			id     string
			status int
			body   any
		}{"delete" + d.OperationName, 200, result.Body})
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			// Validate the actual JSON wire representation, not Go-only map types.
			raw, e := jsonBytes(tc.body)
			if e != nil {
				t.Fatal(e)
			}
			var value any
			if e = decodeJSON(raw, &value); e != nil {
				t.Fatal(e)
			}
			if e = c.ByID[tc.id].ValidateResponse(context.Background(), tc.status, value); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestCareHashOptionalAndNumericSemantics(t *testing.T) {
	scope := Scope{FamilyID: "family", BabyID: "baby"}
	d := careSpecs[0]
	body := Object{"feedingType": "formula", "occurredAt": "2026-05-02T12:04:05+09:00", "amountMl": json.Number("120.0")}
	got, err := careRequestHash(d, "create", scope, "ignored", 0, body)
	if err != nil {
		t.Fatal(err)
	}
	want := hashText(`{"operation":"create","entityType":"feeding","familyId":"family","babyId":"baby","feedingType":"formula","occurredAt":"2026-05-02T03:04:05.000Z","amountMl":120,"leftMinutes":null,"rightMinutes":null,"formulaProductId":null,"spitUp":false,"notes":null}`)
	if got != want {
		t.Fatalf("reference creation hash differs: %s", got)
	}
	body["amountMl"] = "120.0"
	distinct, _ := careRequestHash(d, "create", scope, "ignored", 0, body)
	if got == distinct {
		t.Fatal("numeric string conflated with number")
	}
	absent, _ := careRequestHash(d, "update", scope, "record", 1, Object{})
	null, _ := careRequestHash(d, "update", scope, "record", 1, Object{"notes": nil})
	if absent == null {
		t.Fatal("PATCH absent and null must differ")
	}
	for _, n := range []json.Number{"1.0", "1e0", "1"} {
		if integer(n) != 1 {
			t.Fatalf("integer normalization failed: %s", n)
		}
	}
}

func TestCareDTOAndEventSemantics(t *testing.T) {
	d := careSpecs[0]
	row := Object{"id": testUUID, "amount_ml": json.Number("0.000"), "feeding_type": "legacy", "spit_up": "mild", "occurred_at": testTime, "version": json.Number("2")}
	entity := careEntity(d, row)
	dto := careDTO(d, entity)
	if dto["amountMl"] != "0" || dto["feedingType"] != "formula" || dto["spitUp"] != true || dto["version"] != "2" {
		t.Fatal(dto)
	}
	if row["feeding_type"] != "legacy" {
		t.Fatal("projection mutated database row")
	}
	_, summary, _ := careEvent(d, "create", entity)
	if !strings.Contains(summary, "0ml") {
		t.Fatal("zero decimal lost from projection")
	}
	baby := babyDTO(Object{"gestational_age": json.Number("255"), "gender": "male"})
	if baby["gestationalWeeks"] != int64(36) || baby["gestationalDays"] != int64(3) || baby["gender"] != "boy" {
		t.Fatal(baby)
	}
}

func TestCareVersionAndCursorBoundaries(t *testing.T) {
	for _, v := range []string{"", "0", "01", "-1", "1.0", "1e1", "2147483648", "9007199254740993"} {
		if _, err := parseWireVersion(v); err == nil {
			t.Fatalf("invalid version accepted: %s", v)
		}
	}
	if n, err := parseWireVersion("2147483647"); err != nil || n != 2147483647 {
		t.Fatal(n, err)
	}
	raw := encodeCareCursor(testTime, testUUID)
	date, id, ok := decodeCareCursor(raw)
	if !ok || iso(date) != testTime || id != testUUID {
		t.Fatal("cursor round trip")
	}
	if _, _, ok := decodeCareCursor("!invalid"); ok {
		t.Fatal("invalid cursor accepted")
	}
	r := &Request{HTTP: httptest.NewRequest("GET", "/?limit=200", nil)}
	if pageLimit(r) != 200 {
		t.Fatal("200-page boundary differs")
	}
}

func TestReceiptUnicodeMatchesJSONStringify(t *testing.T) {
	value := "test\u2028line\u2029<&>\\u2028\n"
	actual, e := orderedHash("notes", value)
	if e != nil {
		t.Fatal(e)
	}
	expected := hashText("{\"notes\":\"test\u2028line\u2029<&>\\\\u2028\\n\"}")
	if actual != expected {
		t.Fatal("receipt JSON quoting differs from JavaScript")
	}
}

func TestReferenceRequestValidationSemantics(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	route := c.ByID["createFeedingRecord"]
	params := map[string]string{"babyId": testUUID}
	body := Object{"feedingType": "formula", "occurredAt": testTime, "amountMl": "120.00", "unknown": "discarded"}
	if err = route.Validate(httptest.NewRequest("POST", "/", nil), params, body); err != nil {
		t.Fatal(err)
	}
	if _, exists := body["unknown"]; exists {
		t.Fatal("reference strips additional body properties")
	}
	if body["spitUp"] != false || body["source"] != "ui_manual" {
		t.Fatal("reference defaults missing")
	}
	for _, patch := range []Object{{"amountMl": json.Number("120")}, {"occurredAt": "2026-02-30T03:04:05Z"}} {
		value := copyObject(body)
		for k, v := range patch {
			value[k] = v
		}
		if route.Validate(httptest.NewRequest("POST", "/", nil), params, value) == nil {
			t.Fatal("invalid wire body accepted")
		}
	}
	if route.Validate(httptest.NewRequest("POST", "/", nil), map[string]string{"babyId": "bad-id"}, body) == nil {
		t.Fatal("UUID format not validated")
	}
	query := httptest.NewRequest("GET", "/?limit=1.0&unknown=value", nil)
	if err = c.ByID["listFeedingRecords"].Validate(query, params, nil); err != nil {
		t.Fatal(err)
	}
	if query.URL.Query().Get("limit") != "1" || query.URL.Query().Has("unknown") {
		t.Fatal("query normalization differs")
	}
}

func TestLegacyDeleteVersionDefaults(t *testing.T) {
	for _, d := range careSpecs[1:] {
		for raw, want := range map[string]int64{"": 1, "01": 1, "0": 0, "  +2x": 2} {
			got, err := careBaseVersion(d, "delete", raw)
			if err != nil || got != want {
				t.Fatalf("%s %q: got %d, %v", d.Kind, raw, got, err)
			}
		}
	}
	if _, err := careBaseVersion(careSpecs[0], "delete", ""); err == nil {
		t.Fatal("feeding must require an explicit version")
	}
}
