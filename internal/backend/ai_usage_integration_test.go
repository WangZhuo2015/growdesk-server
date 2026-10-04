//go:build pat_integration

package backend

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestAIUsageAccountingIntegration(t *testing.T) {
	t.Setenv("GROWDESK_AI_BUDGET_UNIT", "ai_run_attempt")
	t.Setenv("GROWDESK_AI_BUDGET_PERIOD", "utc_day")
	t.Setenv("GROWDESK_AI_BUDGET_USER_LIMIT", "2")
	t.Setenv("GROWDESK_AI_BUDGET_FAMILY_LIMIT", "20")
	t.Setenv("GROWDESK_AI_BUDGET_GLOBAL_LIMIT", "100")

	var providerCalls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := providerCalls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer test_virtual_provider_key" {
			http.Error(w, "unexpected virtual provider request", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Idempotency-Key") == "" {
			http.Error(w, "missing attempt idempotency key", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if call == 1 {
			_, _ = fmt.Fprint(w, `{"choices":[{"message":{"content":"test virtual provider answer"}}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"choices":[{"message":{"content":"test virtual provider answer without usage"}}]}`)
	}))
	defer provider.Close()
	t.Setenv("GROWDESK_AI_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_AI_BASE_URL", provider.URL)
	t.Setenv("GROWDESK_AI_API_KEY", "test_virtual_provider_key")
	t.Setenv("GROWDESK_AI_MODEL", "test-virtual-model")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	config, err := LoadConfig()
	if err != nil {
		t.Fatalf("load isolated AI usage test config: %v", err)
	}
	server, err := NewServer(ctx, config, nil)
	if err != nil {
		t.Fatalf("open isolated PostgreSQL/Redis runtime: %v", err)
	}
	server.RegisterBusinessHandlers()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	defer server.Close()

	owner := seedPATTenant(t, ctx, server, "ai_usage_owner")
	foreign := seedPATTenant(t, ctx, server, "ai_usage_foreign")
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		for _, tenant := range []patTenant{owner, foreign} {
			if cleanupErr := cleanupPATUser(cleanupCtx, server, tenant); cleanupErr != nil {
				t.Errorf("cleanup isolated AI usage tenant: %v", cleanupErr)
			}
		}
	}()

	sessionResponse, err := patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/sessions", owner.accessToken,
		map[string]any{"babyId": owner.babyID, "title": "test AI usage session"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, sessionResponse, http.StatusCreated)
	sessionID := text(patData(t, sessionResponse)["id"])
	if sessionID == "" {
		t.Fatal("isolated AI session has no ID")
	}

	createRun := func(messageID, message string) patHTTPResponse {
		t.Helper()
		response, callErr := patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/sessions/"+sessionID+"/runs", owner.accessToken,
			map[string]any{"clientMessageId": messageID, "message": message, "attachmentIds": []string{}})
		if callErr != nil {
			t.Fatal(callErr)
		}
		return response
	}
	firstMessageID, secondMessageID := newID(), newID()
	firstRunResponse := createRun(firstMessageID, "test known provider usage")
	expectPATStatus(t, firstRunResponse, http.StatusAccepted)
	firstRunID := text(patData(t, firstRunResponse)["id"])
	secondRunResponse := createRun(secondMessageID, "test missing provider usage")
	expectPATStatus(t, secondRunResponse, http.StatusAccepted)
	secondRunID := text(patData(t, secondRunResponse)["id"])
	assertPAT(t, firstRunID != "" && secondRunID != "" && firstRunID != secondRunID, "the two isolated AI runs must have distinct IDs")

	// Two unfinished runs occupy the per-user concurrency allowance. No third
	// task or reservation may be created until one run reaches a terminal state.
	thirdMessageID := newID()
	blocked := createRun(thirdMessageID, "test concurrency admission")
	expectPATStatus(t, blocked, http.StatusTooManyRequests)

	for i, expectedRunID := range []string{firstRunID, secondRunID} {
		worked, workErr := server.RunWorkerOnce(ctx, fmt.Sprintf("test_ai_usage_worker_%d", i))
		if workErr != nil {
			t.Fatalf("run isolated virtual-provider worker: %v", workErr)
		}
		assertPAT(t, worked, "worker did not claim isolated AI run %s", expectedRunID)
	}
	assertPAT(t, providerCalls.Load() == 2, "expected exactly two virtual provider calls, got %d", providerCalls.Load())

	// Replaying the same client message after completion returns the existing
	// run. A further worker poll has no eligible task and cannot bill or count it again.
	replay := createRun(firstMessageID, "test known provider usage")
	expectPATStatus(t, replay, http.StatusAccepted)
	assertPAT(t, text(patData(t, replay)["id"]) == firstRunID, "idempotent AI message replay returned a second run")
	worked, err := server.RunWorkerOnce(ctx, "test_ai_usage_replay_worker")
	if err != nil {
		t.Fatal(err)
	}
	assertPAT(t, !worked && providerCalls.Load() == 2, "completed run replay dispatched another provider request")

	usageResponse, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage?babyId="+owner.babyID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, usageResponse, http.StatusOK)
	usage := usageResponse.body
	providerUsage := obj(usage["providerUsage"])
	assertPAT(t, usage["availability"] == "partial", "usage must identify native Go coverage as partial: %#v", usage)
	assertPAT(t, integer(providerUsage["totalAttempts"]) == 2 && integer(providerUsage["modelCalls"]) == 2, "usage should count each real provider dispatch once: %#v", providerUsage)
	assertPAT(t, integer(providerUsage["reportedAttempts"]) == 1 && integer(providerUsage["unknownAttempts"]) == 1,
		"reported and missing usage must remain distinguishable: %#v", providerUsage)
	assertPAT(t, providerUsage["inputTokens"] == nil && providerUsage["outputTokens"] == nil && providerUsage["totalTokens"] == nil && providerUsage["tokenUsageState"] == "partial",
		"aggregate tokens must remain null when one actual response omitted usage: %#v", providerUsage)
	assertPAT(t, providerUsage["costMicros"] == nil && providerUsage["currency"] == nil && providerUsage["costState"] == "unpriced",
		"no rate card exists, so cost must remain unpriced: %#v", providerUsage)
	budget := obj(usage["budget"])
	assertPAT(t, budget["availability"] == "configured" && budget["unit"] == "ai_run_attempt" && budget["period"] == "utc_day" && integer(budget["settledUnits"]) == 2 && integer(budget["remainingUnits"]) == 0,
		"the explicit virtual test budget should show two settled run-attempt units: %#v", budget)
	var firstInput, firstOutput, firstTotal sql.NullInt64
	var firstUsageState, firstStatus string
	if err = server.DB.QueryRow(ctx, `SELECT input_tokens,output_tokens,total_tokens,usage_state,status FROM native_go.ai_provider_attempts WHERE run_id=$1 AND phase='model'`, firstRunID).Scan(&firstInput, &firstOutput, &firstTotal, &firstUsageState, &firstStatus); err != nil {
		t.Fatalf("read first provider attempt: %v", err)
	}
	assertPAT(t, firstInput.Valid && firstInput.Int64 == 12 && firstOutput.Valid && firstOutput.Int64 == 7 && firstTotal.Valid && firstTotal.Int64 == 19 && firstUsageState == "reported" && firstStatus == "reported",
		"known provider usage must be stored exactly: input=%#v output=%#v total=%#v state=%s status=%s", firstInput, firstOutput, firstTotal, firstUsageState, firstStatus)
	var secondInput, secondOutput, secondTotal sql.NullInt64
	var secondUsageState, secondStatus string
	if err = server.DB.QueryRow(ctx, `SELECT input_tokens,output_tokens,total_tokens,usage_state,status FROM native_go.ai_provider_attempts WHERE run_id=$1 AND phase='model'`, secondRunID).Scan(&secondInput, &secondOutput, &secondTotal, &secondUsageState, &secondStatus); err != nil {
		t.Fatalf("read missing-usage provider attempt: %v", err)
	}
	assertPAT(t, !secondInput.Valid && !secondOutput.Valid && !secondTotal.Valid && secondUsageState == "unknown" && secondStatus == "reported",
		"missing provider usage must stay null and unknown despite a successful response: input=%#v output=%#v total=%#v state=%s status=%s", secondInput, secondOutput, secondTotal, secondUsageState, secondStatus)

	foreignUsage, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage", foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, foreignUsage, http.StatusOK)
	assertPAT(t, integer(obj(foreignUsage.body["overview"])["totalCalls"]) == 0 && integer(obj(foreignUsage.body["providerUsage"])["totalAttempts"]) == 0,
		"another isolated account must not see the owner's AI usage: %#v", foreignUsage.body)
	crossBabyUsage, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage?babyId="+owner.babyID, foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, crossBabyUsage, http.StatusNotFound)

	// The completed attempts consume the configured daily allowance. Raising
	// this test-only limit to three admits one queued reservation, which account
	// deletion must release without leaving owner-scoped ledgers behind.
	budgetBlocked := createRun(newID(), "test exhausted AI attempt budget")
	expectPATStatus(t, budgetBlocked, http.StatusTooManyRequests)
	t.Setenv("GROWDESK_AI_BUDGET_USER_LIMIT", "3")
	pending := createRun(newID(), "test pending reservation cleanup")
	expectPATStatus(t, pending, http.StatusAccepted)
	pendingRunID := text(patData(t, pending)["id"])

	var familyReservedBefore, familySettledBefore, globalReservedBefore, globalSettledBefore int64
	if err = server.DB.QueryRow(ctx, `SELECT reserved_units,settled_units FROM native_go.ai_budget_windows WHERE scope_type='family' AND scope_id=$1 AND unit='ai_run_attempt' AND period_start=$2`, owner.familyID, time.Now().UTC().Format("2006-01-02")).Scan(&familyReservedBefore, &familySettledBefore); err != nil {
		t.Fatalf("read family budget before owner deletion: %v", err)
	}
	if err = server.DB.QueryRow(ctx, `SELECT reserved_units,settled_units FROM native_go.ai_budget_windows WHERE scope_type='global' AND scope_id='all' AND unit='ai_run_attempt' AND period_start=$1`, time.Now().UTC().Format("2006-01-02")).Scan(&globalReservedBefore, &globalSettledBefore); err != nil {
		t.Fatalf("read global budget before owner deletion: %v", err)
	}
	assertPAT(t, familyReservedBefore == 1 && familySettledBefore == 2 && globalReservedBefore >= 1 && globalSettledBefore >= 2,
		"pending reservation and settled attempts must be represented before cleanup: family=%d/%d global=%d/%d", familyReservedBefore, familySettledBefore, globalReservedBefore, globalSettledBefore)

	deleted, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/me", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, deleted, http.StatusOK)
	worked, err = server.RunWorkerOnce(ctx, "test_deleted_ai_usage_worker")
	if err != nil {
		t.Fatalf("worker must safely close the now ownerless queued task: %v", err)
	}
	assertPAT(t, !worked, "a revoked owner task must be closed without being dispatched")
	for _, check := range []struct {
		query string
		args  []any
	}{
		{`SELECT count(*) FROM native_go.ai_provider_attempts WHERE user_id=$1`, []any{owner.userID}},
		{`SELECT count(*) FROM native_go.ai_budget_reservations WHERE user_id=$1`, []any{owner.userID}},
		{`SELECT count(*) FROM native_go.mcp_usage_calls WHERE user_id=$1`, []any{owner.userID}},
		{`SELECT count(*) FROM native_go.ai_budget_windows WHERE scope_type='user' AND scope_id=$1`, []any{owner.userID}},
		{`SELECT count(*) FROM task_executions WHERE id=$1 AND status='cancelled'`, []any{pendingRunID}},
	} {
		var count int
		if err = server.DB.QueryRow(ctx, check.query, check.args...).Scan(&count); err != nil {
			t.Fatalf("check owner usage cleanup: %v", err)
		}
		expected := 0
		if check.query == `SELECT count(*) FROM task_executions WHERE id=$1 AND status='cancelled'` {
			expected = 1
		}
		assertPAT(t, count == expected, "account deletion left owner-scoped AI accounting or failed to cancel queued work: %s = %d", check.query, count)
	}
	var familyReservedAfter, familySettledAfter, globalReservedAfter, globalSettledAfter int64
	if err = server.DB.QueryRow(ctx, `SELECT reserved_units,settled_units FROM native_go.ai_budget_windows WHERE scope_type='family' AND scope_id=$1 AND unit='ai_run_attempt' AND period_start=$2`, owner.familyID, time.Now().UTC().Format("2006-01-02")).Scan(&familyReservedAfter, &familySettledAfter); err != nil {
		t.Fatal(err)
	}
	if err = server.DB.QueryRow(ctx, `SELECT reserved_units,settled_units FROM native_go.ai_budget_windows WHERE scope_type='global' AND scope_id='all' AND unit='ai_run_attempt' AND period_start=$1`, time.Now().UTC().Format("2006-01-02")).Scan(&globalReservedAfter, &globalSettledAfter); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, familyReservedAfter == 0 && familySettledAfter == familySettledBefore && globalReservedAfter == globalReservedBefore-1 && globalSettledAfter == globalSettledBefore,
		"account deletion must release undispatched reservations but preserve settled family/global units: family=%d/%d global=%d/%d", familyReservedAfter, familySettledAfter, globalReservedAfter, globalSettledAfter)
	usageAfterDelete, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, usageAfterDelete, http.StatusUnauthorized)

	// Both provider rows were already verified through the owner-scoped API;
	// after account deletion no owner ledger should remain.
	var ledgerCount int64
	if err = server.DB.QueryRow(ctx, `SELECT count(*) FROM native_go.ai_provider_attempts WHERE user_id=$1`, owner.userID).Scan(&ledgerCount); err != nil {
		t.Fatal(err)
	}
	assertPAT(t, ledgerCount == 0, "soft account deletion must purge the provider ledger; got %d rows", ledgerCount)
}
