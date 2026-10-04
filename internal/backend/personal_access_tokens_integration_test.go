//go:build pat_integration

package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type patHTTPResponse struct {
	status int
	body   map[string]any
}

var patIntegrationAssertions atomic.Int64

func patCall(baseURL, method, path, bearer string, body any) (patHTTPResponse, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return patHTTPResponse{}, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, baseURL+path, reader)
	if err != nil {
		return patHTTPResponse{}, err
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return patHTTPResponse{}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return patHTTPResponse{}, err
	}
	var decoded map[string]any
	if len(raw) > 0 {
		if err = json.Unmarshal(raw, &decoded); err != nil {
			return patHTTPResponse{}, fmt.Errorf("decode response: %w", err)
		}
	}
	return patHTTPResponse{status: response.StatusCode, body: decoded}, nil
}

func expectPATStatus(t *testing.T, response patHTTPResponse, want int) {
	t.Helper()
	patIntegrationAssertions.Add(1)
	if response.status != want {
		// The response may contain the one-time PAT on a failed creation check.
		t.Fatalf("HTTP status = %d, want %d", response.status, want)
	}
}

func assertPAT(t *testing.T, condition bool, format string, args ...any) {
	t.Helper()
	patIntegrationAssertions.Add(1)
	if !condition {
		t.Fatalf(format, args...)
	}
}

func patData(t *testing.T, response patHTTPResponse) map[string]any {
	t.Helper()
	patIntegrationAssertions.Add(1)
	data, ok := response.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("response data is not an object: %#v", response.body)
	}
	return data
}

type patTenant struct {
	userID, username     string
	familyID, babyID     string
	familyName, babyName string
	sessionID            string
	accessToken          string
}

func seedPATTenant(t *testing.T, ctx context.Context, s *Server, label string) patTenant {
	t.Helper()
	userID, familyID, babyID, sessionID := newID(), newID(), newID(), newID()
	username := "test_pat_" + label + "_" + strings.ReplaceAll(newID(), "-", "")
	familyName, babyName := "test_family_pat_"+label, "test_baby_pat_"+label
	_, err := s.DB.Exec(ctx, `INSERT INTO users(id,username,password_hash,display_name,created_at,updated_at)
		VALUES($1,$2,'test-only-not-a-login-hash',$3,NOW(),NOW())`, userID, username, username)
	if err != nil {
		t.Fatalf("create isolated test user: %v", err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO user_sync_states(user_id,epoch,cursor,created_at,updated_at)
		VALUES($1,$2,0,NOW(),NOW())`, userID, newID())
	if err != nil {
		t.Fatalf("create isolated user state: %v", err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO families(id,name,timezone,version,created_at,updated_at)
		VALUES($1,$2,'UTC',1,NOW(),NOW())`, familyID, familyName)
	if err != nil {
		t.Fatalf("create isolated test family: %v", err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO family_members(id,family_id,user_id,role,relation,status,version,created_at,updated_at)
		VALUES($1,$2,$3,'admin','parent','active',1,NOW(),NOW())`, newID(), familyID, userID)
	if err != nil {
		t.Fatalf("create test family membership: %v", err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO babies(id,family_id,nickname,birth_date,gender,version,created_at,updated_at)
		VALUES($1,$2,$3,'2026-01-01','unknown',1,NOW(),NOW())`, babyID, familyID, babyName)
	if err != nil {
		t.Fatalf("create isolated test baby: %v", err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO baby_members(id,family_id,baby_id,user_id,role,status,version,created_at,updated_at)
		VALUES($1,$2,$3,$4,'admin','active',1,NOW(),NOW())`, newID(), familyID, babyID, userID)
	if err != nil {
		t.Fatalf("create test baby membership: %v", err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO device_sessions(id,user_id,device_label,platform,created_at,last_seen_at,absolute_expires_at)
		VALUES($1,$2,'test PAT integration','unknown',NOW(),NOW(),NOW()+INTERVAL '1 day')`, sessionID, userID)
	if err != nil {
		t.Fatalf("create isolated test session: %v", err)
	}
	accessToken, err := s.signAccess(userID, sessionID, "test PAT integration")
	if err != nil {
		t.Fatalf("sign isolated test session: %v", err)
	}
	return patTenant{userID: userID, username: username, familyID: familyID, babyID: babyID, familyName: familyName, babyName: babyName, sessionID: sessionID, accessToken: accessToken}
}

func cleanupPATUser(ctx context.Context, s *Server, tenant patTenant) error {
	userID, familyID := tenant.userID, tenant.familyID
	if familyID != "" {
		_, _ = s.DB.Exec(ctx, `DELETE FROM feeding_records WHERE family_id=$1`, familyID)
		_, _ = s.DB.Exec(ctx, `DELETE FROM timeline_entries WHERE family_id=$1`, familyID)
		_, _ = s.DB.Exec(ctx, `DELETE FROM family_changes WHERE family_id=$1`, familyID)
		_, _ = s.DB.Exec(ctx, `DELETE FROM family_sync_states WHERE family_id=$1`, familyID)
	}
	_, _ = s.DB.Exec(ctx, `DELETE FROM task_outbox WHERE aggregate_id IN (SELECT id FROM task_executions WHERE owner_scope=$1)`, "user:"+userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM ai_run_events WHERE run_id IN (SELECT id FROM ai_runs WHERE user_id=$1)`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM ai_runs WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM ai_messages WHERE session_id IN (SELECT id FROM ai_sessions WHERE user_id=$1)`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM ai_sessions WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM task_executions WHERE owner_scope=$1`, "user:"+userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM personal_access_tokens WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM notifications WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM refresh_credentials WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM device_sessions WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM user_changes WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM baby_members WHERE user_id=$1`, userID)
	_, _ = s.DB.Exec(ctx, `DELETE FROM family_members WHERE user_id=$1`, userID)
	if familyID != "" {
		_, _ = s.DB.Exec(ctx, `DELETE FROM babies WHERE family_id=$1`, familyID)
		_, _ = s.DB.Exec(ctx, `DELETE FROM families WHERE id=$1`, familyID)
	}
	_, _ = s.DB.Exec(ctx, `DELETE FROM user_sync_states WHERE user_id=$1`, userID)
	_, err := s.DB.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	return err
}

func patTenantCleanupHash(tenant patTenant) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{tenant.username, tenant.userID, tenant.familyID, tenant.babyID}, "|")))
	return fmt.Sprintf("%x", sum)
}

func remainingPATTenantRows(ctx context.Context, s *Server, tenant patTenant) (int, error) {
	var count int
	err := s.DB.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM users WHERE id=$1 OR username=$2) +
		(SELECT count(*) FROM user_sync_states WHERE user_id=$1) +
		(SELECT count(*) FROM families WHERE id=$3 OR name=$6) +
		(SELECT count(*) FROM babies WHERE id=$4 OR nickname=$7) +
		(SELECT count(*) FROM family_members WHERE user_id=$1 OR family_id=$3) +
		(SELECT count(*) FROM baby_members WHERE user_id=$1 OR family_id=$3 OR baby_id=$4) +
		(SELECT count(*) FROM device_sessions WHERE user_id=$1) +
		(SELECT count(*) FROM personal_access_tokens WHERE user_id=$1) +
		(SELECT count(*) FROM ai_sessions WHERE user_id=$1) +
		(SELECT count(*) FROM ai_runs WHERE user_id=$1) +
		(SELECT count(*) FROM task_executions WHERE owner_scope=$5) +
		(SELECT count(*) FROM feeding_records WHERE family_id=$3) +
		(SELECT count(*) FROM family_sync_states WHERE family_id=$3) +
		(SELECT count(*) FROM family_changes WHERE family_id=$3)`,
		tenant.userID, tenant.username, tenant.familyID, tenant.babyID, "user:"+tenant.userID,
		tenant.familyName, tenant.babyName).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

func TestPersonalAccessTokensHTTPIntegration(t *testing.T) {
	patIntegrationAssertions.Store(0)
	t.Setenv("GROWDESK_AI_PROVIDER", "fixture")
	t.Setenv("GROWDESK_AI_FIXTURE_RESPONSE", `{"text":"A test proposal is ready for review.","actions":[{"actionId":"00000000-0000-4000-8000-000000000001","entityType":"feeding","operation":"create","summary":"Prepare a test bottle record","payload":{"feedingType":"bottle","occurredAt":"2026-10-03T09:00:00.000Z","amountMl":"120","spitUp":false,"notes":"test_pat_proposal"}}]}`)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	config, err := LoadConfig()
	if err != nil {
		t.Fatalf("load isolated native test config: %v", err)
	}
	server, err := NewServer(ctx, config, nil)
	if err != nil {
		t.Fatalf("open isolated PostgreSQL/Redis runtime: %v", err)
	}
	var owner, other patTenant
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		for _, tenant := range []patTenant{owner, other} {
			if tenant.userID == "" {
				continue
			}
			if err := cleanupPATUser(cleanupCtx, server, tenant); err != nil {
				t.Errorf("clean isolated tenant: %v", err)
			}
			remaining, err := remainingPATTenantRows(cleanupCtx, server, tenant)
			patIntegrationAssertions.Add(1)
			if err != nil {
				t.Errorf("verify isolated tenant cleanup: %v", err)
			} else if remaining != 0 {
				t.Errorf("isolated tenant cleanup left %d rows", remaining)
			}
			t.Logf("PAT_CLEANUP tenant_sha256=%s remaining_rows=%d", patTenantCleanupHash(tenant), remaining)
		}
		t.Logf("PAT_HTTP_WORKER_ASSERTIONS=%d", patIntegrationAssertions.Load())
		server.Close()
	}()
	server.RegisterBusinessHandlers()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()

	owner = seedPATTenant(t, ctx, server, "owner")
	other = seedPATTenant(t, ctx, server, "other")

	response, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	items, ok := response.body["data"].([]any)
	assertPAT(t, ok && len(items) == 0, "new test account should have no PATs: %#v", response.body)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{"name": "   "})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusBadRequest)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{
		"name": "test expired at creation", "expiresAt": time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusBadRequest)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{
		"name": "test Siri",
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusCreated)
	primary := patData(t, response)
	pat, _ := primary["token"].(string)
	patID, _ := primary["id"].(string)
	assertPAT(t, strings.HasPrefix(pat, personalAccessTokenPrefix) && len(pat) == len(personalAccessTokenPrefix)+64 && patID != "", "created response lacks a valid one-time opaque token: %#v", primary)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{
		"name": "test expiring token", "expiresAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusCreated)
	expiring := patData(t, response)
	expiringToken, _ := expiring["token"].(string)
	expiringID, _ := expiring["id"].(string)
	assertPAT(t, len(expiringToken) == len(personalAccessTokenPrefix)+64 && expiringID != "", "expiring test credential must be a valid one-time PAT: %#v", expiring)
	var persisted string
	if err = server.DB.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM personal_access_tokens p WHERE p.id=$1`, patID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, !strings.Contains(persisted, pat) && strings.Contains(persisted, hashText(pat)), "plaintext PAT was persisted or its hash was not stored")
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	items, ok = response.body["data"].([]any)
	listedSummariesOnly := ok && len(items) == 2
	if ok {
		for _, item := range items {
			listedSummariesOnly = listedSummariesOnly && !strings.Contains(fmt.Sprint(item), pat) && !strings.Contains(fmt.Sprint(item), expiringToken) && !strings.Contains(fmt.Sprint(item), `"token":`)
		}
	}
	assertPAT(t, listedSummariesOnly, "PAT listing must return only the persisted summaries: %#v", response.body)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{"name": "test scope override", "scopes": []string{"mcp:read"}})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusCreated)
	scopeOverride := patData(t, response)
	scopes, ok := scopeOverride["scopes"].([]any)
	assertPAT(t, ok && len(scopes) == 1 && scopes[0] == "voice:submit", "caller-supplied scope must be ignored and PAT scope remain narrow: %#v", scopeOverride)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", pat, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/ai/sessions", pat, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", owner.accessToken,
		map[string]any{"babyId": owner.babyID, "message": "test request", "clientRequestId": newID()})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodPost, "/mcp", pat,
		map[string]any{"jsonrpc": "2.0", "id": "test", "method": "tools/list"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodPost, "/mcp", owner.accessToken,
		map[string]any{"jsonrpc": "2.0", "id": "test", "method": "tools/list"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	mcpToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "oauth_client_test_pat", "aud": server.mcpResourceAudience(), "iss": "growdesk-api",
		"typ": "at+jwt", "scope": "baby:read baby:write", "iat": time.Now().Unix(),
		"exp": time.Now().Add(time.Hour).Unix(), "jti": newID(),
	}).SignedString([]byte(server.Config.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	assertPAT(t, mcpToken != "", "test MCP audience bearer must be signed")
	parseMCPClaims := jwt.MapClaims{}
	parsedMCP, mcpAudienceErr := jwt.ParseWithClaims(mcpToken, parseMCPClaims,
		func(token *jwt.Token) (any, error) { return []byte(server.Config.JWTSecret), nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithAudience(server.mcpResourceAudience()), jwt.WithExpirationRequired())
	assertPAT(t, mcpAudienceErr == nil && parsedMCP != nil && parsedMCP.Valid, "test bearer should validate for the MCP resource audience")
	parseAppClaims := jwt.MapClaims{}
	_, appAudienceErr := jwt.ParseWithClaims(mcpToken, parseAppClaims,
		func(token *jwt.Token) (any, error) { return []byte(server.Config.JWTSecret), nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithAudience("baby-panel-api"), jwt.WithExpirationRequired())
	assertPAT(t, appAudienceErr != nil, "MCP audience bearer must fail App API audience validation")
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", mcpToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)

	for _, item := range []struct {
		path string
		want int
	}{
		{"/api/v1/connections", http.StatusOK},
		{"/api/v1/me/ai-usage", http.StatusOK},
	} {
		response, err = patCall(httpServer.URL, http.MethodGet, item.path, owner.accessToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		expectPATStatus(t, response, item.want)
	}
	assertPAT(t, response.body["availability"] == "unavailable" && response.body["reasonCode"] == "AI_USAGE_ACCOUNTING_NOT_IMPLEMENTED", "usage endpoint must identify unavailable accounting without fabricated totals: %#v", response.body)
	response, err = patCall(httpServer.URL, http.MethodDelete, "/api/v1/connections/"+newID(), owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusServiceUnavailable)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/connections", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	assertPAT(t, response.body["managementAvailable"] == false && response.body["reasonCode"] == "MCP_OAUTH_GRANTS_NOT_IMPLEMENTED", "connection response must report unavailable grant management: %#v", response.body)
	entries, ok := response.body["data"].([]any)
	assertPAT(t, ok && len(entries) == 0, "connection response should contain the real empty inventory: %#v", response.body)

	// The owner cannot submit against another isolated tenant's baby, even when
	// the caller chooses that babyId in the PAT request body.
	requestID := newID()
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", pat, map[string]any{
		"babyId": other.babyID, "message": "test cross tenant", "clientRequestId": requestID,
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusForbidden)
	// Concurrent retries with one request identifier produce one durable run.
	concurrentID := newID()
	responses := make(chan patHTTPResponse, 2)
	errorsChannel := make(chan error, 2)
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			response, callErr := patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", pat, map[string]any{
				"babyId": owner.babyID, "message": "test proposal", "clientRequestId": concurrentID,
			})
			if callErr != nil {
				errorsChannel <- callErr
				return
			}
			responses <- response
		}()
	}
	group.Wait()
	close(responses)
	close(errorsChannel)
	for callErr := range errorsChannel {
		t.Fatal(callErr)
	}
	var runID string
	for response := range responses {
		expectPATStatus(t, response, http.StatusAccepted)
		id, _ := patData(t, response)["id"].(string)
		assertPAT(t, runID == "" || id == runID, "concurrent idempotent submissions returned different runs: %s, %s", runID, id)
		runID = id
	}
	var duplicateCount int
	if err = server.DB.QueryRow(ctx, `SELECT count(*) FROM task_executions WHERE id=$1 AND owner_scope=$2`, runID, "user:"+owner.userID).Scan(&duplicateCount); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, duplicateCount == 1, "expected one durable task for concurrent retries, got %d", duplicateCount)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", pat, map[string]any{
		"babyId": owner.babyID, "message": "changed request", "clientRequestId": concurrentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusConflict)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/voice/text-runs/"+runID, pat, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)

	worked, err := server.RunWorkerOnce(ctx, "test_pat_integration_worker")
	if err != nil {
		t.Fatalf("process durable test run with fixture provider: %v", err)
	}
	assertPAT(t, worked, "worker did not process the isolated PAT task")
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/voice/text-runs/"+runID, pat, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	runData := patData(t, response)
	assertPAT(t, runData["status"] == "awaiting_confirmation", "worker should persist the proposed action awaiting explicit confirmation: %#v", runData)
	if _, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/runs/"+runID+"/confirm", pat,
		map[string]any{"actionIds": []string{"00000000-0000-4000-8000-000000000001"}, "planHash": obj(runData["proposedPlan"])["planHash"]}); err != nil {
		t.Fatal(err)
	}
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/runs/"+runID+"/confirm", pat,
		map[string]any{"actionIds": []string{"00000000-0000-4000-8000-000000000001"}, "planHash": obj(runData["proposedPlan"])["planHash"]})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/ai/runs/"+runID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	runData = patData(t, response)
	assertPAT(t, runData["status"] == "awaiting_confirmation", "PAT submission must not auto-confirm provider proposals: %#v", runData)
	proposal := obj(runData["proposedPlan"])
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/runs/"+runID+"/confirm", owner.accessToken, map[string]any{
		"actionIds": []string{"00000000-0000-4000-8000-000000000001"}, "planHash": proposal["planHash"],
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	confirmation := patData(t, response)
	feedingID, _ := confirmation["feedingId"].(string)
	if feedingID == "" {
		if err = server.DB.QueryRow(ctx, `SELECT id FROM feeding_records WHERE baby_id=$1 AND notes='test_pat_proposal'`, owner.babyID).Scan(&feedingID); err != nil {
			t.Fatalf("find explicitly confirmed test record: %v", err)
		}
	}
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/babies/"+owner.babyID+"/records/feeding/"+feedingID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	feeding := patData(t, response)
	assertPAT(t, feeding["source"] == "ai_chat" && feeding["notes"] == "test_pat_proposal", "explicitly confirmed record did not read back with its source: %#v", feeding)
	var absentDraft bool
	if err = server.DB.QueryRow(ctx, `SELECT ocr_draft IS NULL FROM ai_runs WHERE id=$1 AND user_id=$2`, runID, owner.userID).Scan(&absentDraft); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, absentDraft, "a non-OCR action run must persist SQL NULL for its absent OCR draft")

	// A plain answer shares the same worker persistence path. Exercise it with
	// actual PostgreSQL constraints as well as the explicitly confirmed action.
	t.Setenv("GROWDESK_AI_FIXTURE_RESPONSE", `{"text":"test plain answer without actions","actions":[]}`)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", pat, map[string]any{
		"babyId": owner.babyID, "message": "test plain answer", "clientRequestId": newID(),
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusAccepted)
	plainRunID := text(patData(t, response)["id"])
	worked, err = server.RunWorkerOnce(ctx, "test_pat_plain_answer_worker")
	if err != nil {
		t.Fatal(err)
	}
	assertPAT(t, worked, "worker did not process the plain-answer task")
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/voice/text-runs/"+plainRunID, pat, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	plainRun := patData(t, response)
	assertPAT(t, plainRun["status"] == "succeeded" && plainRun["resultSummary"] == "test plain answer without actions" && plainRun["proposedPlan"] == nil,
		"a plain answer must complete without a proposal: %#v", plainRun)
	if err = server.DB.QueryRow(ctx, `SELECT ocr_draft IS NULL FROM ai_runs WHERE id=$1 AND user_id=$2`, plainRunID, owner.userID).Scan(&absentDraft); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, absentDraft, "a plain-answer run must persist SQL NULL for its absent OCR draft")

	otherTokenResponse, err := patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", other.accessToken, map[string]any{"name": "test other token"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, otherTokenResponse, http.StatusCreated)
	otherToken := patData(t, otherTokenResponse)
	assertPAT(t, text(otherToken["id"]) != "" && text(otherToken["token"]) != "", "isolated second tenant must receive its own one-time PAT")
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", other.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	ownerItems, ok := response.body["data"].([]any)
	assertPAT(t, ok && len(ownerItems) == 1, "second test tenant should only see its own token: %#v", response.body)
	response, err = patCall(httpServer.URL, http.MethodDelete, "/api/v1/me/tokens/"+patID, other.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusNotFound)
	response, err = patCall(httpServer.URL, http.MethodDelete, "/api/v1/me/tokens/"+text(otherToken["id"]), owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusNotFound)

	// Enforce a bounded token inventory under the user lock.
	var currentTokenCount int
	if err = server.DB.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())`, owner.userID).Scan(&currentTokenCount); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, currentTokenCount == 3, "scope override attempt should add only a voice-scoped token: %d active rows", currentTokenCount)
	for i := 0; i < personalAccessTokenLimit-currentTokenCount; i++ {
		response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken,
			map[string]any{"name": fmt.Sprintf("test extra %02d", i)})
		if err != nil {
			t.Fatal(err)
		}
		expectPATStatus(t, response, http.StatusCreated)
	}
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	items, ok = response.body["data"].([]any)
	assertPAT(t, ok && len(items) == personalAccessTokenLimit, "token list should be capped at %d entries: %#v", personalAccessTokenLimit, response.body)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{"name": "test over limit"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusConflict)

	// Expired recent rows must not hide the older live credentials that the
	// owner still needs to revoke. Recycle only this test tenant's newest token.
	for i := 0; i < personalAccessTokenLimit+2; i++ {
		tag, expireErr := server.DB.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=NOW()-INTERVAL '1 second'
			WHERE id=(SELECT id FROM personal_access_tokens WHERE user_id=$1 AND id<>$2 AND id<>$3
				AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())
				ORDER BY created_at DESC,id DESC LIMIT 1)`, owner.userID, patID, expiringID)
		if expireErr != nil {
			t.Fatal(expireErr)
		}
		assertPAT(t, tag.RowsAffected() == 1, "expected one owned test credential to expire")
		response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken,
			map[string]any{"name": fmt.Sprintf("test recycled expiry %02d", i)})
		if err != nil {
			t.Fatal(err)
		}
		expectPATStatus(t, response, http.StatusCreated)
	}
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/me/tokens", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	items, ok = response.body["data"].([]any)
	assertPAT(t, ok && len(items) == personalAccessTokenLimit, "active inventory must stay complete after expiration")
	listedIDs := make([]string, 0, len(items))
	for _, item := range items {
		listedIDs = append(listedIDs, text(obj(item)["id"]))
	}
	var shownLiveCount int
	if err = server.DB.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens WHERE user_id=$1 AND id=ANY($2::text[])
		AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())`, owner.userID, listedIDs).Scan(&shownLiveCount); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, shownLiveCount == personalAccessTokenLimit, "expired recent rows hid active credentials: shown=%d expected=%d", shownLiveCount, personalAccessTokenLimit)

	// Keep a live primary token for the revocation proof and expire the separate
	// one-time test key to prove request-time expiry enforcement.
	if _, err = server.DB.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, expiringID); err != nil {
		t.Fatal(err)
	}
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", expiringToken, map[string]any{
		"babyId": owner.babyID, "message": "test expired", "clientRequestId": newID(),
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)

	response, err = patCall(httpServer.URL, http.MethodDelete, "/api/v1/me/tokens/"+patID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/text-runs", pat, map[string]any{
		"babyId": owner.babyID, "message": "test after revoke", "clientRequestId": newID(),
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/voice/text-runs/"+runID, pat, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusUnauthorized)
	response, err = patCall(httpServer.URL, http.MethodPost, "/api/v1/me/tokens", owner.accessToken, map[string]any{"name": "test replacement after revoke"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusCreated)
	replacement := patData(t, response)
	replacementToken, _ := replacement["token"].(string)
	assertPAT(t, replacementToken != "" && replacementToken != pat, "replacement token must be a distinct one-time key")
	response, err = patCall(httpServer.URL, http.MethodGet, "/api/v1/voice/text-runs/"+runID, replacementToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
	response, err = patCall(httpServer.URL, http.MethodDelete, "/api/v1/me/tokens/"+patID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, response, http.StatusOK)
}
