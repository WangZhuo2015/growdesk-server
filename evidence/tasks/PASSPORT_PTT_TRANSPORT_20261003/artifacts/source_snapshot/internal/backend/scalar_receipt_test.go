package backend

import (
	"math"
	"testing"
)

func TestScalarReceiptPreservesOrderAndValidatedValues(t *testing.T) {
	r := &Request{RawBody: []byte(`{"notes":"old","weightKg":"8.125","ignored":{"a":1},"notes":"final"}`), Body: Object{"notes": "final", "weightKg": "8.125"}}
	got, err := scalarBodyHash(r)
	if err != nil {
		t.Fatal(err)
	}
	want, err := orderedHash("notes", "final", "weightKg", "8.125")
	if err != nil || got != want {
		t.Fatalf("got %s, want %s, error %v", got, want, err)
	}
	reordered, err := scalarBodyHash(&Request{RawBody: []byte(`{"weightKg":"8.125","notes":"final"}`), Body: r.Body})
	if err != nil || reordered == got {
		t.Fatal("reference order-sensitive hash was silently sorted")
	}
	if r.Body["notes"] != "final" || len(r.Body) != 2 {
		t.Fatal("hash modified the validated body")
	}
}

func TestScalarReceiptNullUnicodeAndFailures(t *testing.T) {
	body := Object{"notes": "<test>\u2028\u2029", "weightKg": nil}
	got, err := scalarBodyHash(&Request{RawBody: []byte("{\"notes\":\"<test>\\u2028\\u2029\",\"weightKg\":null}"), Body: body})
	want, wantErr := orderedHash("notes", body["notes"], "weightKg", nil)
	if err != nil || wantErr != nil || got != want {
		t.Fatalf("unicode/null hash mismatch: %v %v", err, wantErr)
	}
	for _, r := range []*Request{
		{RawBody: nil, Body: Object{}},
		{RawBody: []byte(`[]`), Body: Object{}},
		{RawBody: []byte(`{} {}`), Body: Object{}},
		{RawBody: []byte(`{"a":`), Body: Object{}},
		{RawBody: []byte(`{"a":{}}`), Body: Object{"a": Object{}}},
		{RawBody: []byte(`{}`), Body: Object{"newDefault": true}},
	} {
		if _, err := scalarBodyHash(r); err == nil {
			t.Fatalf("accepted unsupported input %q", r.RawBody)
		}
	}
}

func TestFixedDecimalMatchesJavaScriptTies(t *testing.T) {
	for _, tc := range []struct{ input string; precision int; want string }{
		{"8.125", 2, "8.13"}, {"-8.125", 2, "-8.13"},
		{"1.005", 2, "1.00"}, {"2.675", 2, "2.67"},
		{"10", 2, "10.00"}, {"0", 1, "0.0"},
		{"-0", 2, "0.00"}, {"-0.001", 2, "-0.00"},
		{"72.55", 1, "72.5"}, {"9.999", 2, "10.00"},
	} {
		got, err := fixedJSDecimal(tc.input, tc.precision)
		if err != nil || got != tc.want {
			t.Errorf("%q at %d: got %v, want %s, error %v", tc.input, tc.precision, got, tc.want, err)
		}
	}
	if value, err := fixedJSDecimal(nil, 2); err != nil || value != nil {
		t.Fatal("null must stay null")
	}
	for _, value := range []any{"bad", "NaN", "Infinity", "1e21", math.Inf(1)} {
		if _, err := fixedJSDecimal(value, 2); err == nil {
			t.Fatalf("accepted invalid decimal %v", value)
		}
	}
}
