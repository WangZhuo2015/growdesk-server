package backend

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestKnowledgeMonthCoercion(t *testing.T) {
	for _, raw := range []string{"2", "2.0", "+2", "2e0", " 2 ", "0x2", "0X2", "0o2", "0b10"} {
		got, valid := referenceQueryMonth(raw)
		if !valid || got != 2 {
			t.Fatalf("valid integer representation %q was rejected", raw)
		}
	}
	for _, raw := range []string{"0", "-0", " ", "0.0", "0e9"} {
		got, valid := referenceQueryMonth(raw)
		if !valid || got != 0 {
			t.Fatalf("zero representation %q was rejected", raw)
		}
	}
	for _, raw := range []string{"", "-1", "217", "2.5", "false", "1_0", "0x1p1", "NaN", "Infinity", "-Infinity"} {
		if _, valid := referenceQueryMonth(raw); valid {
			t.Fatalf("invalid month %q was accepted", raw)
		}
	}
}

func TestCatalogValidationPrecedesAuthentication(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{},
		Config: Config{RequestTimeout: time.Second, MaxBodyBytes: 1024}, slots: make(chan struct{}, 2),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	s.registerKnowledge()
	s.registerBooks()
	for _, path := range []string{
		"/api/v1/books", "/api/v1/books?familyId=", "/api/v1/books?familyId=a&familyId=b",
		"/api/v1/development/milestones?month=", "/api/v1/development/activities?month=-1",
		"/api/v1/development/warning-signs?month=2&month=3",
		"/api/v1/development/milestones?category=" + strings.Repeat("a", 81),
	} {
		response := httptest.NewRecorder()
		s.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		var body Object
		if err := decodeJSON(response.Body.Bytes(), &body); err != nil || response.Code != 400 || obj(body["error"])["code"] != "FST_ERR_VALIDATION" {
			t.Fatalf("query was not rejected before auth: %s -> %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestCatalogQueryNormalizationIsScopedAndUnicodeAware(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/v1/development/milestones?month=2.0&unknown=test", nil)
	if err := normalizeReferenceCatalogQuery("listMilestones", r); err != nil || r.URL.Query().Get("month") != "2" || r.URL.Query().Has("unknown") {
		t.Fatalf("normalization mismatch: %v %s", err, r.URL.RawQuery)
	}
	for _, count := range []int{80, 81} {
		r := httptest.NewRequest("GET", "/api/v1/development/milestones?category="+url.QueryEscape(strings.Repeat("测", count)), nil)
		err := normalizeReferenceCatalogQuery("listMilestones", r)
		if (err == nil) != (count == 80) {
			t.Fatal("category length must count code points rather than UTF-8 bytes")
		}
	}
	r = httptest.NewRequest("GET", "/test?month=invalid&unrelated=preserved", nil)
	before := r.URL.RawQuery
	if err := normalizeReferenceCatalogQuery("getHealthLive", r); err != nil || r.URL.RawQuery != before {
		t.Fatal("catalog correction changed an unrelated operation")
	}
}
