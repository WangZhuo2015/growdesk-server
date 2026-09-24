package backend

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNativeSyncAndRecoveryRegistration(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.RegisterBusinessHandlers()

	// Verify the 10 recovered operations are registered and authenticated
	ops := []string{
		"createAiRun", "confirmAiRun", "cancelAiRun", "retryAiRun",
		"createVoiceRun", "createDailySummaryRun", "createMedicalOcrRun",
		"createFamilySnapshot", "getFamilySnapshot",
		"executeSyncCommands",
	}
	for _, id := range ops {
		if s.Handlers[id] == nil {
			t.Errorf("missing handler for %s", id)
		}
		if s.Public[id] {
			t.Errorf("%s must not be public", id)
		}
	}
}

func TestNativeSyncHTTPRouteAndRawBody(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Contract: contract,
		Handlers: map[string]Handler{},
		Public:   map[string]bool{},
		Config:   Config{MaxBodyBytes: 1024, RequestTimeout: 5 * time.Second},
		slots:    make(chan struct{}, 10),
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	s.RegisterBusinessHandlers()

	// 1. Unauthenticated request to /api/v1/sync/commands should return 401
	{
		validBody := `{"commands":[{"commandId":"11111111-1111-1111-1111-111111111111","familyId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","babyId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","entityType":"feeding","entityId":"22222222-2222-2222-2222-222222222222","operation":"create","baseVersion":null,"clientCreatedAt":"2026-09-24T00:00:00Z","payload":{"amountMl":120}}]}`
		req := httptest.NewRequest("POST", "/api/v1/sync/commands", strings.NewReader(validBody))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatalf("unauthenticated sync commands got %d (%s), want 401", rec.Code, rec.Body.String())
		}
	}

	// 2. Mock handler to verify RawBody is captured through HTTP
	var capturedRawBody []byte
	s.Handlers["executeSyncCommands"] = func(ctx context.Context, r *Request) (Result, error) {
		capturedRawBody = r.RawBody
		return s.executeNativeSyncCommands(ctx, r)
	}
	// Bypass auth for isolated body parsing assertions
	s.Public["executeSyncCommands"] = true

	// 2a. Valid command payload: verify RawBody is non-nil and matches the sent bytes
	{
		bodyStr := `{"commands":[{"commandId":"11111111-1111-1111-1111-111111111111","familyId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","babyId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","entityType":"feeding","entityId":"22222222-2222-2222-2222-222222222222","operation":"create","baseVersion":null,"clientCreatedAt":"2026-09-24T00:00:00Z","payload":{"amountMl":120}}]}`
		req := httptest.NewRequest("POST", "/api/v1/sync/commands", strings.NewReader(bodyStr))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)

		if len(capturedRawBody) == 0 {
			t.Fatal("RawBody was not captured for executeSyncCommands through HTTP pipeline")
		}
		if string(capturedRawBody) != bodyStr {
			t.Fatalf("RawBody mismatch: got %q, want %q", string(capturedRawBody), bodyStr)
		}
	}

	// 2b. Conflicting entityId within the same batch should return 422 BATCH_DEPENDENCY_UNRESOLVED
	{
		bodyStr := `{"commands":[{"commandId":"11111111-1111-1111-1111-111111111111","familyId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","babyId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","entityType":"feeding","entityId":"22222222-2222-2222-2222-222222222222","operation":"create","baseVersion":null,"clientCreatedAt":"2026-09-24T00:00:00Z","payload":{}},{"commandId":"33333333-3333-3333-3333-333333333333","familyId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","babyId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","entityType":"feeding","entityId":"22222222-2222-2222-2222-222222222222","operation":"update","baseVersion":"1","clientCreatedAt":"2026-09-24T00:01:00Z","payload":{}}]}`
		req := httptest.NewRequest("POST", "/api/v1/sync/commands", strings.NewReader(bodyStr))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 422 {
			t.Fatalf("duplicate entityId got %d, want 422", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "BATCH_DEPENDENCY_UNRESOLVED") {
			t.Fatalf("expected BATCH_DEPENDENCY_UNRESOLVED error, got %s", rec.Body.String())
		}
	}

	// 2c. Empty batch should return 400
	{
		bodyStr := `{"commands":[]}`
		req := httptest.NewRequest("POST", "/api/v1/sync/commands", strings.NewReader(bodyStr))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Fatalf("empty commands batch got %d, want 400", rec.Code)
		}
	}

	// 2d. Body too large (> 1024 bytes configured) should return 413
	{
		huge := `{"commands":[{"entityType":"feeding","entityId":"11111111-1111-1111-1111-111111111111","action":"create","payload":{"notes":"` + strings.Repeat("a", 2000) + `"}}]}`
		req := httptest.NewRequest("POST", "/api/v1/sync/commands", strings.NewReader(huge))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 413 {
			t.Fatalf("oversized body got %d, want 413", rec.Code)
		}
	}

	// 2e. Invalid Content-Type should return 415
	{
		req := httptest.NewRequest("POST", "/api/v1/sync/commands", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "text/plain")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 415 {
			t.Fatalf("invalid media type got %d, want 415", rec.Code)
		}
	}
}

func TestNativeFullOperationCoverage(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.registerHealth()
	s.RegisterBusinessHandlers()

	// Verify all 151 operations are registered
	var missing []string
	for _, route := range contract.Routes {
		if s.Handlers[route.OperationID] == nil {
			missing = append(missing, route.OperationID)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("missing %d operations: %v", len(missing), missing)
	}
	if len(s.Handlers) != 151 {
		t.Fatalf("expected 151 handlers, got %d", len(s.Handlers))
	}
}

func TestNativeOAuthAndSamplesHTTP(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Contract: contract,
		Handlers: map[string]Handler{},
		Public:   map[string]bool{},
		Config:   Config{MaxBodyBytes: 1048576, RequestTimeout: 5 * time.Second, PublicURL: "http://127.0.0.1:3081", JWTSecret: "test-jwt-secret-12345678901234567890"},
		slots:    make(chan struct{}, 10),
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	s.registerHealth()
	s.RegisterBusinessHandlers()

	// 1. /.well-known/oauth-authorization-server
	{
		req := httptest.NewRequest("GET", "/.well-known/oauth-authorization-server", nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("oauth metadata got %d, want 200: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "token_endpoint") {
			t.Fatalf("missing token_endpoint in %s", rec.Body.String())
		}
	}

	// 2. /.well-known/oauth-protected-resource
	{
		req := httptest.NewRequest("GET", "/.well-known/oauth-protected-resource", nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("protected resource metadata got %d, want 200: %s", rec.Code, rec.Body.String())
		}
	}

	// 3. /.well-known/oauth-protected-resource/mcp
	{
		req := httptest.NewRequest("GET", "/.well-known/oauth-protected-resource/mcp", nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("protected mcp metadata got %d, want 200: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "/mcp") {
			t.Fatalf("expected /mcp in %s", rec.Body.String())
		}
	}

	// 4. POST /sample/timeline
	{
		bodyStr := `{"kind":"feeding","id":"11111111-1111-1111-1111-111111111111","volumeMl":120}`
		req := httptest.NewRequest("POST", "/sample/timeline", strings.NewReader(bodyStr))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("sample timeline got %d, want 200: %s", rec.Code, rec.Body.String())
		}
	}

	// 5. POST /mcp unauthenticated -> 401
	{
		req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":"1","method":"ping"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatalf("unauthenticated mcp got %d, want 401: %s", rec.Code, rec.Body.String())
		}
	}
}

