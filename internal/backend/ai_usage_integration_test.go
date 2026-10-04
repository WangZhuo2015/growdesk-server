//go:build pat_integration

package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestAIUsageAccountingIntegration(t *testing.T) {
	t.Setenv("GROWDESK_AI_BUDGET_UNIT", "ai_run_attempt")
	t.Setenv("GROWDESK_AI_BUDGET_PERIOD", "utc_day")
	t.Setenv("GROWDESK_AI_BUDGET_USER_LIMIT", "2")
	t.Setenv("GROWDESK_AI_BUDGET_FAMILY_LIMIT", "20")
	t.Setenv("GROWDESK_AI_BUDGET_GLOBAL_LIMIT", "100")

	var providerCalls atomic.Int64
	var providerMode atomic.Value
	providerMode.Store("accounting")
	var providerScenarioMu sync.Mutex
	providerScenarioCalls := map[string]int{}
	providerScenarioKeys := map[string][]string{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := providerCalls.Add(1)
		mode := providerMode.Load().(string)
		wantPath := "/chat/completions"
		if mode == "asr" {
			wantPath = "/audio/transcriptions"
		}
		if r.Method != http.MethodPost || r.URL.Path != wantPath || r.Header.Get("Authorization") != "Bearer test_virtual_provider_key" {
			http.Error(w, "unexpected virtual provider request", http.StatusBadRequest)
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			http.Error(w, "missing attempt idempotency key", http.StatusBadRequest)
			return
		}
		providerScenarioMu.Lock()
		providerScenarioCalls[mode]++
		providerScenarioKeys[mode] = append(providerScenarioKeys[mode], key)
		scenarioCall := providerScenarioCalls[mode]
		providerScenarioMu.Unlock()
		if mode == "timeout" {
			// Keep the virtual upstream alive beyond the client deadline without
			// relying on net/http propagating client cancellation to Request.Context.
			// A bounded delay also guarantees httptest.Server.Close cannot hang.
			time.Sleep(250 * time.Millisecond)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if mode == "rate_limit" && scenarioCall == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		if mode == "asr" {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				http.Error(w, "invalid multipart body", http.StatusBadRequest)
				return
			}
			file, header, err := r.FormFile("file")
			if err != nil {
				http.Error(w, "missing audio file", http.StatusBadRequest)
				return
			}
			defer file.Close()
			body, err := io.ReadAll(file)
			if err != nil || header.Filename != "voice.m4a" || string(body) != "test isolated audio bytes" ||
				r.FormValue("model") != "test-virtual-asr-model" || r.FormValue("response_format") != "json" {
				http.Error(w, "unexpected virtual ASR payload", http.StatusBadRequest)
				return
			}
			_, _ = fmt.Fprint(w, `{"text":"test transcript","usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`)
			providerMode.Store("accounting")
			return
		}
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
	t.Setenv("GROWDESK_ASR_MODEL", "test-virtual-asr-model")
	providerScenarioStats := func(mode string) (int, []string) {
		providerScenarioMu.Lock()
		defer providerScenarioMu.Unlock()
		return providerScenarioCalls[mode], append([]string(nil), providerScenarioKeys[mode]...)
	}

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
	if server.ObjectStore != nil {
		if _, err = server.ObjectStore.Client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(server.ObjectStore.Bucket)}); err != nil {
			t.Fatalf("create owned loopback object bucket: %v", err)
		}
	}
	server.RegisterBusinessHandlers()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	defer server.Close()

	owner := seedPATTenant(t, ctx, server, "ai_usage_owner")
	foreign := seedPATTenant(t, ctx, server, "ai_usage_foreign")
	reliability := seedPATTenant(t, ctx, server, "ai_usage_reliability")
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		for _, tenant := range []patTenant{owner, foreign, reliability} {
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
	usageContract, err := LoadContract()
	if err != nil {
		t.Fatalf("load generated API contract for HTTP response validation: %v", err)
	}
	if err = usageContract.ByID["getPersonalAIUsage"].ValidateResponse(ctx, usageResponse.status, usageResponse.body); err != nil {
		t.Errorf("real populated AI usage HTTP response must satisfy its generated contract: %v", err)
	}
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

	// Separate reliability scenarios run after the original owner-scope and
	// deletion assertions so their provider attempts cannot skew those totals.
	t.Setenv("GROWDESK_AI_BUDGET_USER_LIMIT", "10")
	reliabilitySession, err := patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/sessions", reliability.accessToken,
		map[string]any{"babyId": reliability.babyID, "title": "test retry reliability session"})
	if err != nil {
		t.Fatal(err)
	}
	expectPATStatus(t, reliabilitySession, http.StatusCreated)
	reliabilitySessionID := text(patData(t, reliabilitySession)["id"])
	createReliabilityRun := func(message string) string {
		t.Helper()
		response, callErr := patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/sessions/"+reliabilitySessionID+"/runs", reliability.accessToken,
			map[string]any{"clientMessageId": newID(), "message": message, "attachmentIds": []string{}})
		if callErr != nil {
			t.Fatal(callErr)
		}
		expectPATStatus(t, response, http.StatusAccepted)
		return text(patData(t, response)["id"])
	}
	readReliabilityState := func(runID string) (string, string) {
		t.Helper()
		var taskStatus, errorCode string
		if queryErr := server.DB.QueryRow(ctx, `SELECT t.status,COALESCE(r.error_code,'') FROM task_executions t JOIN ai_runs r ON r.id=t.id WHERE t.id=$1`, runID).Scan(&taskStatus, &errorCode); queryErr != nil {
			t.Fatalf("read reliability run state: %v", queryErr)
		}
		return taskStatus, errorCode
	}
	forceNativeDispatch := func(runID string) {
		t.Helper()
		// next_dispatch_at is TIMESTAMPTZ(3), so storing clock_timestamp() can
		// round forward by almost a millisecond and remain momentarily ineligible.
		// Backdate by a second to make this test-only immediate dispatch stable.
		if _, execErr := server.DB.Exec(ctx, `UPDATE task_outbox SET next_dispatch_at=clock_timestamp()-INTERVAL '1 second' WHERE aggregate_id=$1 AND phase_key='native-initial' AND dispatch_state='active'`, runID); execErr != nil {
			t.Fatalf("make isolated test dispatch immediately eligible: %v", execErr)
		}
	}
	checkAI := func(condition bool, format string, args ...any) {
		t.Helper()
		if !condition {
			t.Errorf(format, args...)
		}
	}
	requireAI := func(condition bool, format string, args ...any) {
		t.Helper()
		if !condition {
			t.Fatalf(format, args...)
		}
	}
	assertFirstEligibleNativeTask := func(expectedID, scenario string) {
		t.Helper()
		var actualID string
		if queryErr := server.DB.QueryRow(ctx, `SELECT t.id FROM task_executions t
			WHERE t.kind=ANY($1::text[]) AND t.cancel_requested_at IS NULL
			AND (t.status='queued' OR (t.status='running' AND t.lease_expires_at<clock_timestamp()))
			AND EXISTS(SELECT 1 FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial' AND o.payload_version=1
				AND o.dispatch_state='active' AND o.next_dispatch_at<=clock_timestamp() AND o.payload ? '__native')
			ORDER BY t.created_at,t.id LIMIT 1`, nativeTaskKinds).Scan(&actualID); queryErr != nil {
			var status, kind, dispatchState string
			var attempt int64
			var expired, notCancelled, supported, versionOne, due, hasNative bool
			diagnosticErr := server.DB.QueryRow(ctx, `SELECT t.status,t.kind,t.attempt,COALESCE(t.lease_expires_at<clock_timestamp(),false),t.cancel_requested_at IS NULL,
				t.kind=ANY($2::text[]),o.payload_version=1,o.dispatch_state,o.next_dispatch_at<=clock_timestamp(),o.payload ? '__native'
				FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial' WHERE t.id=$1`,
				expectedID, nativeTaskKinds).Scan(&status, &kind, &attempt, &expired, &notCancelled, &supported, &versionOne, &dispatchState, &due, &hasNative)
			if diagnosticErr != nil {
				t.Fatalf("%s must have an eligible native task: %v; target state unavailable: %v", scenario, queryErr, diagnosticErr)
			}
			t.Fatalf("%s must have an eligible native task: %v; target status=%s kind=%s attempt=%d expired=%v uncancelled=%v supported=%v payloadVersion1=%v dispatch=%s due=%v hasNative=%v",
				scenario, queryErr, status, kind, attempt, expired, notCancelled, supported, versionOne, dispatchState, due, hasNative)
		}
		if actualID != expectedID {
			t.Fatalf("%s must target the expected first eligible task: expected=%s actual=%s", scenario, expectedID, actualID)
		}
	}
	if server.ObjectStore != nil {
		// Exercise the actual multipart ASR path against owned loopback object
		// storage and the virtual provider; the model response is a second,
		// separately accounted phase on the same durable voice run.
		audio := []byte("test isolated audio bytes")
		audioHash := sha256.Sum256(audio)
		audioKey, audioAttachmentID := "test-ai-usage/"+newID()+".m4a", newID()
		if _, err = server.ObjectStore.Client.PutObject(ctx, &s3.PutObjectInput{
			Bucket: aws.String(server.ObjectStore.Bucket), Key: aws.String(audioKey),
			Body: bytes.NewReader(audio), ContentLength: aws.Int64(int64(len(audio))),
		}); err != nil {
			t.Fatalf("store isolated virtual audio bytes: %v", err)
		}
		if _, err = server.DB.Exec(ctx, `INSERT INTO attachments(id,family_id,baby_id,uploader_id,purpose,mime_type,byte_size,sha256,object_key,status,expires_at)
			VALUES($1,$2,$3,$4,'voice_note','audio/m4a',$5,$6,$7,'ready',NOW()+INTERVAL '1 day')`, audioAttachmentID,
			reliability.familyID, reliability.babyID, reliability.userID, len(audio), hex.EncodeToString(audioHash[:]), audioKey); err != nil {
			t.Fatalf("create isolated ready audio attachment: %v", err)
		}
		modelCallsBefore, _ := providerScenarioStats("accounting")
		providerMode.Store("asr")
		voiceResponse, callErr := patCall(httpServer.URL, http.MethodPost, "/api/v1/voice/runs", reliability.accessToken,
			map[string]any{"babyId": reliability.babyID, "attachmentId": audioAttachmentID, "clientRequestId": newID()})
		if callErr != nil {
			t.Fatal(callErr)
		}
		expectPATStatus(t, voiceResponse, http.StatusAccepted)
		voiceRunID := text(patData(t, voiceResponse)["runId"])
		worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_asr_worker")
		if err != nil {
			t.Fatalf("run isolated ASR plus model phases: %v", err)
		}
		checkAI(worked, "voice run with a stored test audio object was not claimed")
		asrCalls, asrKeys := providerScenarioStats("asr")
		checkAI(asrCalls == 1 && len(asrKeys) == 1, "one actual multipart ASR dispatch is expected; calls=%d keys=%v", asrCalls, asrKeys)
		modelCallsAfter, _ := providerScenarioStats("accounting")
		checkAI(modelCallsAfter == modelCallsBefore+1, "voice transcription should dispatch one follow-up model phase; calls=%d/%d", modelCallsBefore, modelCallsAfter)
		var voiceLedgerVerified bool
		if err = server.DB.QueryRow(ctx, `SELECT
			EXISTS(SELECT 1 FROM native_go.ai_provider_attempts WHERE run_id=$1 AND phase='asr' AND attempt=1
				AND status='reported' AND usage_state='reported' AND input_tokens=3 AND output_tokens=1 AND total_tokens=4)
			AND EXISTS(SELECT 1 FROM native_go.ai_provider_attempts WHERE run_id=$1 AND phase='model' AND attempt=1
				AND status='reported' AND usage_state='unknown' AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL)
			AND EXISTS(SELECT 1 FROM task_executions WHERE id=$1 AND status='succeeded')`, voiceRunID).Scan(&voiceLedgerVerified); err != nil {
			t.Fatalf("read voice-run provider usage phases: %v", err)
		}
		checkAI(voiceLedgerVerified, "actual ASR and model phases must remain distinct, preserve unknown model usage, and complete the voice run")
	} else {
		t.Log("ASR integration requires --s3; model-phase accounting remains covered by this suite")
	}

	providerMode.Store("rate_limit")
	rateLimitRunID := createReliabilityRun("test known rate limit retries safely")
	assertFirstEligibleNativeTask(rateLimitRunID, "first rate-limit dispatch")
	worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_rate_limit_worker_1")
	if err != nil {
		t.Fatalf("run rate-limited isolated provider attempt: %v", err)
	}
	requireAI(worked, "rate-limited run was not claimed")
	forceNativeDispatch(rateLimitRunID)
	assertFirstEligibleNativeTask(rateLimitRunID, "known rate-limit retry")
	worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_rate_limit_worker_2")
	if err != nil {
		t.Fatalf("run safely retried isolated provider attempt: %v", err)
	}
	requireAI(worked, "known provider rejection did not retain the safe automatic retry")
	rateLimitCalls, rateLimitKeys := providerScenarioStats("rate_limit")
	requireAI(rateLimitCalls == 2 && len(rateLimitKeys) == 2 && rateLimitKeys[0] != rateLimitKeys[1],
		"a known 429 must retry with a new attempt key; calls=%d keys=%v", rateLimitCalls, rateLimitKeys)
	rateLimitStatus, _ := readReliabilityState(rateLimitRunID)
	requireAI(rateLimitStatus == "succeeded", "safe known rejection retry must complete; task status=%s", rateLimitStatus)
	var rejectedStatus, rejectedCode string
	if err = server.DB.QueryRow(ctx, `SELECT status,COALESCE(error_code,'') FROM native_go.ai_provider_attempts WHERE run_id=$1 AND attempt=1 AND phase='model'`, rateLimitRunID).Scan(&rejectedStatus, &rejectedCode); err != nil {
		t.Fatalf("read known-rejection provider audit: %v", err)
	}
	checkAI(rejectedStatus == "failed" && rejectedCode == "AI_PROVIDER_RATE_LIMITED",
		"known 429 must be audited as a rejected attempt: status=%s code=%s", rejectedStatus, rejectedCode)

	providerMode.Store("timeout")
	t.Setenv("GROWDESK_AI_TIMEOUT_MS", "100")
	timeoutRunID := createReliabilityRun("test provider timeout is not replayed automatically")
	assertFirstEligibleNativeTask(timeoutRunID, "first timeout dispatch")
	worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_timeout_worker")
	if err != nil {
		t.Fatalf("run timed-out isolated provider attempt: %v", err)
	}
	requireAI(worked, "timed-out run was not claimed")
	timeoutCalls, timeoutKeys := providerScenarioStats("timeout")
	requireAI(timeoutCalls == 1 && len(timeoutKeys) == 1, "one timed-out dispatch must be observed, calls=%d keys=%v", timeoutCalls, timeoutKeys)
	timeoutStatus, timeoutCode := readReliabilityState(timeoutRunID)
	requireAI(timeoutStatus == "failed" && timeoutCode == "AI_PROVIDER_OUTCOME_UNKNOWN",
		"uncertain provider timeout must be terminal and visible; task status=%s code=%s", timeoutStatus, timeoutCode)
	// The timeout path already made this run terminal. Advancing its outbox
	// timestamp must not make it eligible again; the next worker poll is
	// expected to find no task and must not issue another provider call.
	worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_timeout_recovery_worker")
	if err != nil {
		t.Fatalf("poll timed-out run recovery: %v", err)
	}
	afterRecoveryCalls, afterRecoveryKeys := providerScenarioStats("timeout")
	requireAI(!worked && afterRecoveryCalls == 1 && len(afterRecoveryKeys) == 1,
		"reconciliation must not issue a second provider request after an uncertain timeout; worked=%v calls=%d keys=%v", worked, afterRecoveryCalls, afterRecoveryKeys)
	var timeoutAttemptStatus string
	if err = server.DB.QueryRow(ctx, `SELECT status FROM native_go.ai_provider_attempts WHERE run_id=$1 AND attempt=1 AND phase='model'`, timeoutRunID).Scan(&timeoutAttemptStatus); err != nil {
		t.Fatalf("read timed-out provider audit: %v", err)
	}
	checkAI(timeoutAttemptStatus == "unknown", "timed-out provider attempt must be audited unknown, got %s", timeoutAttemptStatus)
	if timeoutStatus != "failed" {
		// Keep the legacy implementation's retry from starving later scenarios;
		// the assertions above retain the failing evidence.
		_, _ = server.DB.Exec(ctx, `UPDATE task_executions SET status='failed' WHERE id=$1`, timeoutRunID)
		_, _ = server.DB.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1 AND phase_key='native-initial'`, timeoutRunID)
	}
	noConfirmRetry, err := patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/runs/"+timeoutRunID+"/retry", reliability.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	checkAI(noConfirmRetry.status == http.StatusConflict,
		"retry after unknown provider outcome must require explicit duplicate-work confirmation; status=%d body=%#v", noConfirmRetry.status, noConfirmRetry.body)
	if noConfirmRetry.status == http.StatusConflict {
		confirmedRetry, retryErr := patCall(httpServer.URL, http.MethodPost, "/api/v1/ai/runs/"+timeoutRunID+"/retry?confirmPossibleDuplicate=true", reliability.accessToken, nil)
		if retryErr != nil {
			t.Fatal(retryErr)
		}
		checkAI(confirmedRetry.status == http.StatusAccepted, "explicit duplicate-work confirmation should allow manual retry, status=%d body=%#v", confirmedRetry.status, confirmedRetry.body)
		if confirmedRetry.status == http.StatusAccepted {
			providerMode.Store("manual_success")
			worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_confirmed_retry_worker")
			if err != nil {
				t.Fatalf("run explicitly confirmed provider retry: %v", err)
			}
			checkAI(worked, "explicitly confirmed retry was not dispatched")
		}
	} else {
		// Before the guard is implemented the route accepts the retry. Finish it
		// under the virtual provider so cleanup sees no pending task.
		providerMode.Store("manual_success")
		worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_legacy_retry_cleanup_worker")
		if err != nil {
			t.Fatalf("finish legacy retry fixture: %v", err)
		}
	}

	// Exercise the exact durable state left when a worker loses its lease after
	// persisting provider usage but before it commits the run result.
	providerMode.Store("result_lost")
	resultLostRunID := createReliabilityRun("test provider response can outlive run commit")
	assertFirstEligibleNativeTask(resultLostRunID, "result-loss lease fixture claim")
	lease, found, err := server.claimNativeTask(ctx, "test_ai_usage_result_lost_owner")
	if err != nil {
		t.Fatalf("claim result-loss fixture: %v", err)
	}
	requireAI(found && lease.ID == resultLostRunID, "expected to claim only the result-loss fixture; found=%v run=%s claimed=%s", found, resultLostRunID, lease.ID)
	providerConfig, err := nativeProviderConfiguration()
	if err != nil {
		t.Fatal(err)
	}
	_, err = callNativeAI(withNativeUsageTracker(ctx, server, lease, "model"), providerConfig,
		lease.Input.SessionID, lease.Input.BabyID, lease.Input.Message, lease.Input.AttachmentIDs, nil)
	if err != nil {
		t.Fatalf("persist a real virtual-provider response before simulating lost run commit: %v", err)
	}
	resultLostCalls, _ := providerScenarioStats("result_lost")
	if _, err = server.DB.Exec(ctx, `UPDATE task_executions SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1 AND status='running'`, resultLostRunID); err != nil {
		t.Fatalf("expire result-loss lease: %v", err)
	}
	var debugStatus, debugKind string
	var debugExpired, debugEligible, debugNotCancelled, debugReported bool
	if err = server.DB.QueryRow(ctx, `SELECT t.status,t.kind,t.lease_expires_at<clock_timestamp(),t.cancel_requested_at IS NULL,
		EXISTS(SELECT 1 FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial' AND o.payload_version=1
			AND o.dispatch_state='active' AND o.next_dispatch_at<=clock_timestamp() AND o.payload ? '__native'),
		EXISTS(SELECT 1 FROM native_go.ai_provider_attempts p WHERE p.run_id=t.id AND p.attempt=t.attempt AND p.status='reported')
		FROM task_executions t WHERE t.id=$1`, resultLostRunID).Scan(&debugStatus, &debugKind, &debugExpired, &debugNotCancelled, &debugEligible, &debugReported); err != nil {
		t.Fatalf("inspect result-loss lease eligibility: %v", err)
	}
	requireAI(debugStatus == "running" && debugKind == "ai_chat_run" && debugExpired && debugNotCancelled && debugEligible && debugReported,
		"result-loss recovery fixture must be an expired, dispatchable lease with a reported provider result; status=%s kind=%s expired=%v uncancelled=%v eligible=%v reported=%v",
		debugStatus, debugKind, debugExpired, debugNotCancelled, debugEligible, debugReported)
	forceNativeDispatch(resultLostRunID)
	var firstRecoveryCandidate string
	if err = server.DB.QueryRow(ctx, `SELECT t.id FROM task_executions t
		WHERE t.kind=ANY($1::text[]) AND t.cancel_requested_at IS NULL
		AND (t.status='queued' OR (t.status='running' AND t.lease_expires_at<clock_timestamp()))
		AND EXISTS(SELECT 1 FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial' AND o.payload_version=1
			AND o.dispatch_state='active' AND o.next_dispatch_at<=clock_timestamp() AND o.payload ? '__native')
		ORDER BY t.created_at,t.id LIMIT 1`, nativeTaskKinds).Scan(&firstRecoveryCandidate); err != nil {
		var afterStatus, afterKind, afterDispatchState string
		var afterExpired, afterNotCancelled, afterKindSupported, afterOutboxVersion, afterDispatchDue, afterHasNative bool
		inspectErr := server.DB.QueryRow(ctx, `SELECT t.status,t.kind,t.lease_expires_at<clock_timestamp(),t.cancel_requested_at IS NULL,
			t.kind=ANY($2::text[]),o.payload_version=1,o.dispatch_state,o.next_dispatch_at<=clock_timestamp(),o.payload ? '__native'
			FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial' WHERE t.id=$1`,
			resultLostRunID, nativeTaskKinds).Scan(&afterStatus, &afterKind, &afterExpired, &afterNotCancelled, &afterKindSupported,
			&afterOutboxVersion, &afterDispatchState, &afterDispatchDue, &afterHasNative)
		if inspectErr != nil {
			t.Fatalf("inspect first recovery candidate: %v; inspect target state: %v", err, inspectErr)
		}
		t.Fatalf("inspect first recovery candidate: %v; target after dispatch has status=%s kind=%s expired=%v uncancelled=%v supported=%v payloadVersion1=%v dispatch=%s due=%v hasNative=%v",
			err, afterStatus, afterKind, afterExpired, afterNotCancelled, afterKindSupported, afterOutboxVersion, afterDispatchState, afterDispatchDue, afterHasNative)
	}
	if firstRecoveryCandidate != resultLostRunID {
		t.Fatalf("result-loss recovery must be the first eligible task: expected=%s actual=%s", resultLostRunID, firstRecoveryCandidate)
	}
	worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_result_lost_recovery_worker")
	if err != nil {
		t.Fatalf("reconcile result-loss lease: %v", err)
	}
	afterResultLostCalls, _ := providerScenarioStats("result_lost")
	resultLostStatus, resultLostCode := readReliabilityState(resultLostRunID)
	checkAI(!worked && afterResultLostCalls == resultLostCalls && resultLostStatus == "failed" && resultLostCode == "AI_PROVIDER_RESULT_NOT_PERSISTED",
		"a reported provider result without a durable run result must stop lease replay; worked=%v calls=%d/%d task=%s code=%s",
		worked, resultLostCalls, afterResultLostCalls, resultLostStatus, resultLostCode)

	// A dispatched request whose response is lost must also stop at lease
	// recovery. The virtual server waits for the owned client timeout.
	providerMode.Store("timeout")
	unknownLeaseRunID := createReliabilityRun("test expired lease preserves unknown provider outcome")
	assertFirstEligibleNativeTask(unknownLeaseRunID, "unknown-outcome lease fixture claim")
	unknownLease, found, err := server.claimNativeTask(ctx, "test_ai_usage_unknown_lease_owner")
	if err != nil {
		t.Fatalf("claim unknown-outcome lease fixture: %v", err)
	}
	requireAI(found && unknownLease.ID == unknownLeaseRunID, "expected to claim unknown-outcome fixture; found=%v run=%s claimed=%s", found, unknownLeaseRunID, unknownLease.ID)
	beforeUnknownLeaseCalls, _ := providerScenarioStats("timeout")
	_, timeoutErr := callNativeAI(withNativeUsageTracker(ctx, server, unknownLease, "model"), providerConfig,
		unknownLease.Input.SessionID, unknownLease.Input.BabyID, unknownLease.Input.Message, unknownLease.Input.AttachmentIDs, nil)
	checkAI(timeoutErr != nil, "virtual provider timeout should leave the outcome unknown")
	if _, err = server.DB.Exec(ctx, `UPDATE task_executions SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1 AND status='running'`, unknownLeaseRunID); err != nil {
		t.Fatalf("expire unknown-outcome lease: %v", err)
	}
	forceNativeDispatch(unknownLeaseRunID)
	assertFirstEligibleNativeTask(unknownLeaseRunID, "unknown-outcome lease recovery")
	worked, err = server.RunWorkerOnce(ctx, "test_ai_usage_unknown_lease_recovery_worker")
	if err != nil {
		t.Fatalf("reconcile unknown-outcome lease: %v", err)
	}
	afterUnknownLeaseCalls, _ := providerScenarioStats("timeout")
	unknownLeaseStatus, unknownLeaseCode := readReliabilityState(unknownLeaseRunID)
	requireAI(!worked && afterUnknownLeaseCalls == beforeUnknownLeaseCalls+1 && unknownLeaseStatus == "failed" && unknownLeaseCode == "AI_PROVIDER_OUTCOME_UNKNOWN",
		"uncertain lease recovery must not dispatch again and must expose the unknown outcome; worked=%v calls=%d/%d task=%s code=%s",
		worked, beforeUnknownLeaseCalls, afterUnknownLeaseCalls, unknownLeaseStatus, unknownLeaseCode)
}
