package backend

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
)

func foodLibraryWire(t *testing.T, value any) any {
	t.Helper()
	raw, err := jsonBytes(value)
	if err != nil {
		t.Fatal(err)
	}
	var result any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestFoodLibraryFamilySelection(t *testing.T) {
	for _, tc := range []struct {
		name, requested string
		active          []string
		want, code      string
		status          int
	}{
		{"implicit sole family", "", []string{"a"}, "a", "", 0},
		{"explicit first", "a", []string{"a", "b"}, "a", "", 0},
		{"explicit second", "b", []string{"a", "b"}, "b", "", 0},
		{"ambiguous", "", []string{"a", "b"}, "", "FAMILY_SELECTION_REQUIRED", 400},
		{"no membership", "", nil, "", "FAMILY_ACCESS_DENIED", 403},
		{"foreign family", "c", []string{"a", "b"}, "", "FAMILY_ACCESS_DENIED", 403},
		{"explicit without membership", "a", nil, "", "FAMILY_ACCESS_DENIED", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := selectFoodLibraryFamily(tc.requested, tc.active)
			if got != tc.want {
				t.Fatalf("family=%q, want %q", got, tc.want)
			}
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected explicit scope error")
			}
			e := normalizedError(err)
			if e.Code != tc.code || e.Status != tc.status {
				t.Fatalf("error=%+v", e)
			}
		})
	}
}

func TestFoodLibraryWireContract(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	item := foodLibraryItem{ID: "custom_00000000-0000-4000-8000-000000000001", Name: "test_food", Category: "fruit", AllergenRisk: "low"}
	for _, tc := range []struct {
		name   string
		status *foodLibraryStatus
	}{
		{"absent", nil},
		{"explicit false", &foodLibraryStatus{Tried: false}},
		{"explicit true", &foodLibraryStatus{Tried: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item.FamilyStatus = tc.status
			wire := foodLibraryWire(t, item).(map[string]any)
			if _, exists := wire["data"]; exists {
				t.Fatal("POST response must not acquire a data envelope")
			}
			if wire["recommendedAgeMonths"] != float64(0) {
				t.Fatal("zero age must be serialized")
			}
			status, exists := wire["familyStatus"]
			if exists != (tc.status != nil) {
				t.Fatal("missing and explicit status must remain distinct")
			}
			if tc.status != nil {
				if !reflect.DeepEqual(status, map[string]any{"tried": tc.status.Tried, "reaction": nil}) {
					t.Fatalf("status=%#v", status)
				}
			}
			// The frozen OpenAPI wraps this item in data, but the actual
			// Fastify route returns FoodLibraryItemSchema directly. Validate
			// the DTO here; the discrepancy and real HTTP wire have separate tests.
			schema := c.ByID["createFoodLibraryItem"].Operation.Responses.Status(201).Value.Content.Get("application/json").Schema.Value.Properties["data"].Value
			if err := schema.VisitJSON(wire, wireFormats...); err != nil {
				t.Fatal(err)
			}
		})
	}
	empty := foodLibraryWire(t, envelope(make([]foodLibraryItem, 0)))
	if !reflect.DeepEqual(empty, map[string]any{"data": []any{}}) {
		t.Fatalf("empty catalog=%#v, want an array", empty)
	}
	if err := c.ByID["listFoodLibraryItems"].ValidateResponse(context.Background(), 200, empty); err != nil {
		t.Fatal(err)
	}
}

// Track the existing spec/runtime disagreement explicitly. Do not change the
// reference artifact or silently claim whole-envelope OpenAPI compatibility.
// scripts/go-food-library-integration.py compares the actual Fastify response.
func TestFoodLibraryKnownOpenAPIEnvelopeDrift(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	item := foodLibraryWire(t, foodLibraryItem{ID: "test_food", Name: "test_food", Category: "fruit", AllergenRisk: "low", RecommendedAgeMonths: 6})
	route := c.ByID["createFoodLibraryItem"]
	if err := route.ValidateResponse(context.Background(), 201, item); err == nil {
		t.Fatal("frozen OpenAPI envelope changed: review and remove the documented compatibility exception")
	}
	if err := route.ValidateResponse(context.Background(), 201, envelope(item)); err != nil {
		t.Fatalf("unexpected drift beyond the known data envelope: %v", err)
	}
}

func TestFoodLibraryRegistrationAndGuidelines(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: c, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.registerFoodLibrary()
	for _, id := range []string{"listFoodLibraryItems", "createFoodLibraryItem", "getFoodGuidelines"} {
		if s.Handlers[id] == nil || s.Public[id] {
			t.Fatalf("%s must have an authenticated native handler", id)
		}
	}
	first := foodGuidelines()
	first[0].Title = "mutated"
	first[0].ForbiddenFoods[0] = "mutated"
	result, err := s.Handlers["getFoodGuidelines"](context.Background(), &Request{})
	if err != nil {
		t.Fatal(err)
	}
	if foodGuidelines()[0].Title == "mutated" || foodGuidelines()[0].ForbiddenFoods[0] == "mutated" {
		t.Fatal("guidelines share mutable state")
	}
	if err := c.ByID["getFoodGuidelines"].ValidateResponse(context.Background(), 200, foodLibraryWire(t, result.Body)); err != nil {
		t.Fatal(err)
	}
}

func TestFoodLibraryRejectsMalformedRequests(t *testing.T) {
	c, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	for _, patch := range []Object{
		{"name": ""}, {"category": ""}, {"allergenRisk": "unknown"},
		{"recommendedAgeMonths": -1}, {"recommendedAgeMonths": 1.5},
		{"familyId": "not-a-uuid"},
	} {
		body := Object{"name": "test_food", "category": "fruit", "allergenRisk": "low", "recommendedAgeMonths": 6}
		for key, value := range patch {
			body[key] = value
		}
		r := httptest.NewRequest("POST", "/api/v1/food/items", nil)
		if err := c.ByID["createFoodLibraryItem"].Validate(r, nil, body); err == nil || normalizedError(err).Code != "FST_ERR_VALIDATION" {
			t.Fatalf("invalid request accepted: %#v: %v", patch, err)
		}
	}
}
