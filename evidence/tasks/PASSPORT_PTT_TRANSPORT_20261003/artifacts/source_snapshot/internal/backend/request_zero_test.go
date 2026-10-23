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
	request := func() *Request {
		req := httptest.NewRequest("POST", strings.ReplaceAll(route.Path, "{babyId}", babyID), nil)
		req.Header.Set("Idempotency-Key", "00000000-0000-4000-8000-000000000003")
		return &Request{HTTP: req, Params: map[string]string{"babyId": babyID}}
	}
	makeHash := func(minutes any, amount any) string {
		t.Helper()
		// Durations are numbers; amountMl is a decimal STRING in this contract.
		body := Object{"feedingType": "breast", "occurredAt": "2026-09-22T00:00:00.000Z",
			"leftMinutes": minutes, "amountMl": amount}
		req := request()
		if err := route.Validate(req.HTTP, req.Params, body); err != nil {
			t.Fatal(err)
		}
		if body["amountMl"] != amount {
			t.Fatal("wire validation coerced a decimal string or null")
		}
		hash, err := careRequestHash(careSpecs[0], "create", scope, "", 0, body)
		if err != nil {
			t.Fatal(err)
		}
		return hash
	}
	positive := makeHash(json.Number("0"), nil)
	for _, raw := range []string{"-0", "-0.0", "-0e20", "0.0"} {
		if got := makeHash(json.Number(raw), nil); got != positive {
			t.Fatalf("equivalent numeric retry %s changed the receipt", raw)
		}
	}
	if makeHash(json.Number("0"), "0.0") == makeHash(json.Number("0"), "0") {
		t.Fatal("distinct decimal-string receipt semantics were lost")
	}
	for _, amount := range []any{json.Number("0"), json.Number("-0"), false} {
		body := Object{"feedingType": "bottle", "occurredAt": "2026-09-22T00:00:00.000Z", "amountMl": amount}
		req := request()
		if err := route.Validate(req.HTTP, req.Params, body); err == nil {
			t.Fatal("non-string amountMl incorrectly accepted")
		}
	}
}
