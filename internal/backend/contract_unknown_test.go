package backend

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestFoodPlanUnknownValuesIncludeNull(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	const baby = "a0000000-0000-4000-8000-000000000002"
	for _, value := range []any{nil, false, json.Number("0"), "", Object{}, []any{}, Object{"nested": nil}, []any{nil}} {
		body := Object{"baseVersion": "0", "planData": Object{"value": value}}
		request := httptest.NewRequest("PUT", "/api/v1/babies/"+baby+"/food-plan", nil)
		if err := contract.ByID["saveFoodPlan"].Validate(request, map[string]string{"babyId": baby}, body); err != nil {
			t.Fatalf("arbitrary JSON %#v rejected: %v", value, err)
		}
		if !reflect.DeepEqual(obj(body["planData"])["value"], value) {
			t.Fatal("arbitrary JSON value changed during validation")
		}
		response := envelope(Object{"id": nil, "babyId": baby, "planData": body["planData"], "createdAt": nil, "updatedAt": "2026-01-02T03:04:05.000Z", "version": "0"})
		if err := contract.ByID["getFoodPlan"].ValidateResponse(context.Background(), 200, response); err != nil {
			t.Fatalf("arbitrary response JSON %#v rejected: %v", value, err)
		}
	}
	for _, value := range []any{nil, false, "", []any{}} {
		request := httptest.NewRequest("PUT", "/api/v1/babies/"+baby+"/food-plan", nil)
		if err := contract.ByID["saveFoodPlan"].Validate(request, map[string]string{"babyId": baby}, Object{"baseVersion": "0", "planData": value}); err == nil {
			t.Fatalf("typed plan document accepted non-object %#v", value)
		}
	}
}

func TestUnknownSchemaAdaptationPreservesLiteralData(t *testing.T) {
	raw := []byte(`{"components":{"schemas":{"Test":{"type":"object","properties":{"free":{},"strict":{"type":"object","additionalProperties":false}},"example":{"schema":{},"properties":{"free":{}}},"default":{"items":{}}}}}}`)
	result, err := nullableReferenceContract(raw)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(result, &document); err != nil {
		t.Fatal(err)
	}
	schema := obj(obj(obj(document["components"])["schemas"])["Test"])
	if obj(obj(schema["properties"])["free"])["nullable"] != true {
		t.Fatal("empty property schema did not preserve null")
	}
	if _, changed := obj(obj(schema["properties"])["strict"])["nullable"]; changed {
		t.Fatal("typed non-null object was weakened")
	}
	if !reflect.DeepEqual(schema["example"], map[string]any{"schema": map[string]any{}, "properties": map[string]any{"free": map[string]any{}}}) {
		t.Fatal("example literal changed")
	}
	if !reflect.DeepEqual(schema["default"], map[string]any{"items": map[string]any{}}) {
		t.Fatal("default literal changed")
	}
}
