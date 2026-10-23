package backend

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestNullableReferencePreservesNonNullValidation(t *testing.T) {
	original := []byte(`{"openapi":"3.0.3","info":{"title":"test","version":"1"},"paths":{},"components":{"schemas":{
	"Item":{"type":"object","required":["id"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1}}},
	"OptionalItem":{"type":"object","required":["data"],"properties":{"data":{"$ref":"#/components/schemas/Item","nullable":true}}},
	"RequiredItem":{"type":"object","required":["data"],"properties":{"data":{"$ref":"#/components/schemas/Item"}}}
	}}}`)
	adapted, err := nullableReferenceContract(original)
	if err != nil {
		t.Fatal(err)
	}
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromData(adapted)
	if err != nil {
		t.Fatal(err)
	}
	optional := doc.Components.Schemas["OptionalItem"].Value
	required := doc.Components.Schemas["RequiredItem"].Value
	for _, value := range []any{nil, map[string]any{"id": "test"}} {
		if err := optional.VisitJSON(map[string]any{"data": value}); err != nil {
			t.Fatal("valid nullable reference rejected", err)
		}
	}
	for _, value := range []any{map[string]any{}, map[string]any{"id": ""}, map[string]any{"id": "test", "extra": true}, "text", false, float64(0), []any{}} {
		if err := optional.VisitJSON(map[string]any{"data": value}); err == nil {
			t.Fatalf("nullable branch accepted invalid non-null data: %#v", value)
		}
	}
	if err := optional.VisitJSON(map[string]any{}); err == nil {
		t.Fatal("required nullable property must not become optional")
	}
	if err := required.VisitJSON(map[string]any{"data": nil}); err == nil {
		t.Fatal("adapting one reference mutated its shared non-nullable target")
	}
	if err := required.VisitJSON(map[string]any{"data": map[string]any{"id": "test"}}); err != nil {
		t.Fatal(err)
	}
}

func TestNullableReferenceDoesNotRewriteExamples(t *testing.T) {
	raw := []byte(`{"example":{"$ref":"literal-user-data","nullable":true},"default":{"$ref":"literal-user-data","nullable":true}}`)
	adapted, err := nullableReferenceContract(raw)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	if err := json.Unmarshal(raw, &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(adapted, &after); err != nil {
		t.Fatal(err)
	}
	for key := range before {
		value := after[key].(map[string]any)
		if value["$ref"] != "literal-user-data" || value["nullable"] != true {
			t.Fatal("literal contract example was changed")
		}
	}
}

func TestFrozenVoiceUnreadContractAcceptsOnlyDeclaredShapes(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	route, _ := contract.Match("GET", "/api/v1/voice/logs")
	if route == nil {
		t.Fatal("voice route absent")
	}
	if err := route.ValidateResponse(context.Background(), 200, map[string]any{"data": nil}); err != nil {
		t.Fatal("reference null unread result rejected", err)
	}
	for _, value := range []any{map[string]any{}, false, "invalid", float64(1)} {
		if err := route.ValidateResponse(context.Background(), 200, map[string]any{"data": value}); err == nil {
			t.Fatalf("invalid voice result accepted: %#v", value)
		}
	}
}
