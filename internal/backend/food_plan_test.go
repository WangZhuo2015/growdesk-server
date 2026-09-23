package backend

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"testing"
)

func TestFoodPlanVersion(t *testing.T) {
	for raw, want := range map[string]int64{"0": 0, "1": 1, "9007199254740993": 9007199254740993, "9223372036854775807": math.MaxInt64} {
		got, err := foodPlanVersion(raw)
		if err != nil || got != want {
			t.Fatalf("%q: %d, %v; want %d", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "-1", "1.0", "1e3", " 1", "1 ", "x", "9223372036854775808"} {
		if _, err := foodPlanVersion(raw); err == nil || normalizedError(err).Code != "INVALID_BASE_VERSION" {
			t.Fatalf("invalid version %q accepted: %v", raw, err)
		}
	}
}

func TestFoodPlanPreconditionBeforeBodyValidation(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	route := contract.ByID["saveFoodPlan"]
	const baby = "a0000000-0000-4000-8000-000000000001"
	for _, body := range []Object{nil, {}, {"planData": Object{}}, {"baseVersion": nil}, {"baseVersion": false}, {"baseVersion": json.Number("0")}} {
		req := httptest.NewRequest("PUT", "/api/v1/babies/"+baby+"/food-plan", nil)
		err := route.Validate(req, map[string]string{"babyId": baby}, body)
		if err == nil || normalizedError(err).Status != 409 || normalizedError(err).Code != "CONCURRENCY_CONFLICT" {
			t.Fatalf("missing/non-string CAS must be 409, got %v for %#v", err, body)
		}
	}
	req := httptest.NewRequest("PUT", "/api/v1/babies/"+baby+"/food-plan", nil)
	if err := route.Validate(req, map[string]string{"babyId": baby}, Object{"baseVersion": "0", "planData": Object{"zero": 0, "flag": false, "empty": []any{}}}); err != nil {
		t.Fatal(err)
	}
	if err := route.Validate(req, map[string]string{"babyId": baby}, Object{"baseVersion": "0", "planData": nil}); err == nil {
		t.Fatal("null document must not pass the object schema")
	}
}

func TestFoodPlanDTOAndNativeRegistration(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	server.RegisterBusinessHandlers()
	for _, id := range []string{"getFoodPlan", "saveFoodPlan"} {
		if server.Handlers[id] == nil || server.Public[id] {
			t.Fatalf("%s must have an authenticated native handler", id)
		}
	}
	row := Object{
		"id": "a0000000-0000-4000-8000-000000000001", "baby_id": "a0000000-0000-4000-8000-000000000002",
		"family_id": "private", "plan_data": Object{"null": nil, "zero": json.Number("0"), "flag": false, "empty": []any{}},
		"version": json.Number("9007199254740993"), "created_at": "2026-01-02T03:04:05Z", "updated_at": "2026-01-02T03:04:05Z",
	}
	data := foodPlanDTO(row)
	if data["version"] != "9007199254740993" || len(data) != 6 {
		t.Fatalf("unexpected DTO: %#v", data)
	}
	if _, leaked := data["familyId"]; leaked {
		t.Fatal("persistence-only field leaked")
	}
	if err := contract.ByID["getFoodPlan"].ValidateResponse(context.Background(), 200, envelope(data)); err != nil {
		t.Fatal(err)
	}
	if row["created_at"] != "2026-01-02T03:04:05Z" {
		t.Fatal("DTO mutated persistence row")
	}
}
