package backend

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSampleGrowthRequiresAuthentication(t *testing.T) {
	contract, err := LoadContract()
	if err != nil { t.Fatal(err) }
	s := &Server{
		Config: Config{RequestTimeout: time.Second, MaxBodyBytes: 1024},
		Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{},
		Log: slog.Default(), slots: make(chan struct{}, 1),
	}
	s.registerSamples()
	if s.Public["getGrowthRecord"] { t.Fatal("real growth data registered as public") }
	request := httptest.NewRequest("GET", "/sample/growth/00000000-0000-4000-8000-000000000001", nil)
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != 401 { t.Fatalf("anonymous sample read: %d", response.Code) }
	// Direct callers must also fail before attempting any database operation.
	_, err = s.getGrowthRecord(context.Background(), &Request{Params: map[string]string{"id": "test_record"}})
	if err == nil || normalizedError(err).Status != 401 { t.Fatalf("missing principal accepted: %v", err) }
}
