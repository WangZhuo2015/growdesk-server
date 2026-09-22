package backend

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizedJSONZeroPreservesTypes(t *testing.T) {
	for _, raw := range []string{"0", "-0", "-0.0", "0.000", "-0e20"} {
		if got := normalizedJSONZero(json.Number(raw)); got != json.Number("0") {
			t.Fatalf("numeric zero %s was not canonicalized", raw)
		}
	}
	for _, value := range []any{nil, false, "0", "0.0", "-0", json.Number("0.125"), json.Number("-1"), json.Number("1e9999")} {
		if got := normalizedJSONZero(value); !reflect.DeepEqual(got, value) {
			t.Fatalf("changed nonzero value or scalar type: %T", value)
		}
	}
}

func TestFeedingSignedZeroHasSameReceiptAfterWireValidation(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	route := contract.ByID["createFeedingRecord"]
	if route == nil {
		t.Fatal("missing frozen feeding operation")
	}
	const babyID = "00000000-0000-4000-8000-000000000001"
	scope := Scope{FamilyID: "00000000-0000-4000-8000-000000000002", BabyID: babyID}
	makeHash := func(amount any) string {
		t.Helper()
		body := Object{"feedingType": "bottle", "occurredAt": "2026-09-22T00:00:00.000Z", "amountMl": amount}
		req := httptest.NewRequest("POST", strings.ReplaceAll(route.Path, "{babyId}", babyID), nil)
		req.Header.Set("Idempotency-Key", "00000000-0000-4000-8000-000000000003")
		if err := route.Validate(req, map[string]string{"babyId": babyID}, body); err != nil {
			t.Fatal(err)
		}
		if _, isString := amount.(string); isString && body["amountMl"] != amount {
			t.Fatal("wire validation coerced a decimal string")
		}
		hash, err := careRequestHash(careSpecs[0], "create", scope, "", 0, body)
		if err != nil {
			t.Fatal(err)
		}
		return hash
	}
	positive := makeHash(json.Number("0"))
	for _, raw := range []string{"-0", "-0.0", "-0e20", "0.0"} {
		if got := makeHash(json.Number(raw)); got != positive {
			t.Fatalf("equivalent numeric retry %s changed the receipt", raw)
		}
	}
	if makeHash("0.0") == positive || makeHash("0.0") == makeHash("0") {
		t.Fatal("distinct decimal-string receipt semantics were lost")
	}
}
