package backend

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// PostgreSQL owns queue state, attempts, cancellation and fencing. Workers
// consume only outbox rows created by this native runtime; a BullMQ job is not
// a compatible native lease. No provider call happens inside a DB transaction.
const nativeLeaseSeconds = 20

var nativeTaskKinds = []string{
	"ai_chat_run", "voice_transcription", "daily_summary_synthesis",
	"medical_ocr", "growth_ocr", "sync_snapshot_family", "user_data_export", "push_delivery",
}

type nativeTaskInput struct {
	Version        int      `json:"version"`
	UserID         string   `json:"userId"`
	FamilyID       string   `json:"familyId,omitempty"`
	BabyID         string   `json:"babyId,omitempty"`
	SessionID      string   `json:"sessionId,omitempty"`
	MessageID      string   `json:"clientMessageId,omitempty"`
	Message        string   `json:"message,omitempty"`
	AttachmentIDs  []string `json:"attachmentIds,omitempty"`
	TargetDate     string   `json:"targetDate,omitempty"`
	SnapshotID     string   `json:"snapshotId,omitempty"`
	NotificationID string   `json:"notificationId,omitempty"`
	PushDeviceID   string   `json:"pushDeviceId,omitempty"`
}
type nativeTaskLease struct {
	ID, Kind, Owner string
	Attempt         int64
	Fence           int64
	Input           nativeTaskInput
}

func nativeTaskKind(kind string) bool {
	for _, candidate := range nativeTaskKinds {
		if candidate == kind {
			return true
		}
	}
	return false
}

func nativeTaskOwner(ctx context.Context, q Querier, input nativeTaskInput, write bool) error {
	if input.Version != 1 || input.UserID == "" {
		return errors.New("invalid native task owner")
	}
	var active bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL)`, input.UserID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return apiError(401, "UNAUTHORIZED", "Task owner is no longer active")
	}
	if input.BabyID != "" {
		scope, err := babyScope(ctx, q, input.UserID, input.BabyID, write)
		if err != nil {
			return err
		}
		if scope.FamilyID != input.FamilyID {
			return apiError(403, "BABY_SCOPE_MISMATCH", "Task scope changed")
		}
	} else if input.FamilyID != "" {
		if _, err := familyRole(ctx, q, input.UserID, input.FamilyID); err != nil {
			return err
		}
	}
	return nil
}

// checkNativeAIConcurrency serializes the user, family, and global admission
// checks. Callers that already acquired the user lock can safely call it again;
// PostgreSQL transaction advisory locks are re-entrant within one transaction.
func checkNativeAIConcurrency(ctx context.Context, tx pgx.Tx, input nativeTaskInput) error {
	familyLimit, globalLimit, err := nativeAIConcurrencyPolicy()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,73649))`, input.UserID); err != nil {
		return err
	}
	if input.FamilyID != "" {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,73650))`, "ai-family:"+input.FamilyID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('ai-global-runs',73650))`); err != nil {
		return err
	}
	var userActive, familyActive, globalActive int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_executions WHERE owner_scope=$1 AND kind=ANY($2::text[])
		AND status IN ('queued','running','cancelling','awaiting_confirmation')`, "user:"+input.UserID, nativeAIRunKinds).Scan(&userActive); err != nil {
		return err
	}
	if userActive >= 2 {
		return apiError(429, "AI_CONCURRENCY_LIMIT", "A user may have at most two unfinished AI runs")
	}
	if input.FamilyID != "" {
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
			WHERE t.kind=ANY($2::text[]) AND t.status IN ('queued','running','cancelling','awaiting_confirmation')
			AND o.payload->'__native'->>'familyId'=$1`, input.FamilyID, nativeAIRunKinds).Scan(&familyActive); err != nil {
			return err
		}
		if familyActive >= familyLimit {
			return apiError(429, "AI_CONCURRENCY_LIMIT", "The family AI concurrency limit is reached")
		}
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_executions WHERE kind=ANY($1::text[])
		AND status IN ('queued','running','cancelling','awaiting_confirmation')`, nativeAIRunKinds).Scan(&globalActive); err != nil {
		return err
	}
	if globalActive >= globalLimit {
		return apiError(429, "AI_CONCURRENCY_LIMIT", "The global AI concurrency limit is reached")
	}
	return nil
}

func enqueueNativeTask(ctx context.Context, tx pgx.Tx, id, kind string, input nativeTaskInput) error {
	if !nativeTaskKind(kind) || !actionUUID.MatchString(id) || input.Version != 1 || input.UserID == "" {
		return errors.New("invalid native task")
	}
	// Serialize the quota with other submissions by this user, including
	// submissions for different families. Never accept this owner from an LLM.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,73649))`, input.UserID); err != nil {
		return err
	}
	if isNativeAIRun(kind) {
		if err := checkNativeAIConcurrency(ctx, tx, input); err != nil {
			return err
		}
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM task_executions WHERE owner_scope=$1 AND status IN ('queued','running','cancelling','awaiting_confirmation')`, "user:"+input.UserID).Scan(&count); err != nil {
		return err
	}
	if count >= 64 {
		return apiError(429, "TASK_QUOTA_EXCEEDED", "Too many unfinished tasks")
	}
	raw, err := jsonText(Object{"__native": input})
	if err != nil {
		return err
	}
	if len(raw) > 512*1024 {
		return invalid("Task input exceeds the size budget")
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_executions(id,kind,owner_scope,status,attempt,max_attempts,fence_token,next_event_seq,created_at,updated_at)
		VALUES($1,$2,$3,'queued',0,3,0,0,NOW(),NOW())`, id, kind, "user:"+input.UserID)
	if err != nil {
		return err
	}
	if isNativeAIRun(kind) {
		if err = reserveNativeAIAttempt(ctx, tx, id, input, 1); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_outbox(id,type,aggregate_id,payload_version,payload,phase_key,dispatch_state,next_dispatch_at,created_at)
		VALUES($1,$2,$3,1,$4::jsonb,'native-initial','active',NOW(),NOW())`, newID(), kind, id, raw)
	return err
}
func decodeNativeTaskInput(row Object) (nativeTaskInput, error) {
	var input nativeTaskInput
	raw, err := jsonBytes(obj(row["payload"])["__native"])
	if err != nil {
		return input, err
	}
	if err = decodeJSON(raw, &input); err != nil {
		return input, err
	}
	if input.Version != 1 || input.UserID == "" || text(row["owner_scope"]) != "user:"+input.UserID {
		return input, errors.New("task owner metadata mismatch")
	}
	return input, nil
}

// Lock task first, then its event sequence. Every event writer uses this order;
// callers holding a family/session lock must acquire those before this lock.
func appendNativeRunEvent(ctx context.Context, tx pgx.Tx, id, kind string, payload Object) error {
	var seq int64
	err := tx.QueryRow(ctx, `UPDATE ai_runs SET last_event_seq=last_event_seq+1,updated_at=NOW() WHERE id=$1 AND last_event_seq<9223372036854775807 RETURNING last_event_seq`, id).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	raw, err := jsonText(payload)
	if err != nil {
		return err
	}
	if len(raw) > 250*1024 {
		return errors.New("AI event exceeds bounded frame size")
	}
	_, err = tx.Exec(ctx, `INSERT INTO ai_run_events(id,run_id,sequence,event_type,payload,created_at) VALUES($1,$2,$3,$4,$5::jsonb,NOW())`, newID(), id, seq, kind, raw)
	return err
}
func (s *Server) claimNativeTask(ctx context.Context, owner string) (nativeTaskLease, bool, error) {
	var lease nativeTaskLease
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return lease, false, err
	}
	defer rollback(tx)
	candidate, err := one(ctx, tx, `SELECT to_jsonb(t) FROM task_executions t
		WHERE t.kind=ANY($1::text[]) AND t.cancel_requested_at IS NULL
		AND (t.status='queued' OR (t.status='running' AND t.lease_expires_at<clock_timestamp()))
		AND EXISTS(SELECT 1 FROM task_outbox o WHERE o.aggregate_id=t.id
			AND o.phase_key='native-initial' AND o.payload_version=1
			AND o.dispatch_state='active' AND o.next_dispatch_at<=clock_timestamp() AND o.payload ? '__native')
		ORDER BY t.created_at,t.id LIMIT 1`, nativeTaskKinds)
	if errors.Is(err, pgx.ErrNoRows) {
		return lease, false, nil
	}
	if err != nil {
		return lease, false, err
	}
	id := text(candidate["id"])
	outbox, err := one(ctx, tx, `SELECT to_jsonb(o) FROM task_outbox o WHERE aggregate_id=$1 AND phase_key='native-initial' ORDER BY created_at,id LIMIT 1`, id)
	if err != nil {
		return lease, false, err
	}
	outbox["owner_scope"] = candidate["owner_scope"]
	candidateInput, decodeErr := decodeNativeTaskInput(outbox)
	// Match the submission and retry lock order: owner, family, then task. This
	// serializes account deletion and permission changes with provider dispatch
	// without creating a task->owner lock cycle with cancel/retry operations.
	if decodeErr == nil {
		if err = lockUser(ctx, tx, candidateInput.UserID); err != nil {
			return lease, false, err
		}
		if candidateInput.FamilyID != "" {
			if _, err = lockFamily(ctx, tx, candidateInput.FamilyID); err != nil {
				return lease, false, err
			}
		}
	} else if ownerScope := text(candidate["owner_scope"]); strings.HasPrefix(ownerScope, "user:") && actionUUID.MatchString(strings.TrimPrefix(ownerScope, "user:")) {
		if err = lockUser(ctx, tx, strings.TrimPrefix(ownerScope, "user:")); err != nil {
			return lease, false, err
		}
	}
	row, err := one(ctx, tx, `SELECT to_jsonb(t) FROM task_executions t
		WHERE t.id=$1 AND t.kind=ANY($2::text[]) AND t.cancel_requested_at IS NULL
		AND (t.status='queued' OR (t.status='running' AND t.lease_expires_at<clock_timestamp()))
		AND EXISTS(SELECT 1 FROM task_outbox o WHERE o.aggregate_id=t.id
			AND o.phase_key='native-initial' AND o.payload_version=1
			AND o.dispatch_state='active' AND o.next_dispatch_at<=clock_timestamp() AND o.payload ? '__native')
		FOR UPDATE OF t SKIP LOCKED`, id, nativeTaskKinds)
	if errors.Is(err, pgx.ErrNoRows) {
		return lease, false, nil
	}
	if err != nil {
		return lease, false, err
	}
	outbox, err = one(ctx, tx, `SELECT to_jsonb(o) FROM task_outbox o WHERE aggregate_id=$1 AND phase_key='native-initial' ORDER BY created_at,id LIMIT 1`, id)
	if err != nil {
		return lease, false, err
	}
	outbox["owner_scope"] = row["owner_scope"]
	input, err := decodeNativeTaskInput(outbox)
	if err != nil || candidateInput.UserID != "" && (candidateInput.UserID != input.UserID || candidateInput.FamilyID != input.FamilyID || candidateInput.BabyID != input.BabyID) {
		if err == nil {
			err = errors.New("task scope changed while being claimed")
		}
		if isNativeAIRun(text(row["kind"])) {
			attempt := max(int64(1), integer(row["attempt"]))
			dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, id, attempt)
			if usageErr != nil {
				return lease, false, usageErr
			}
			if usageErr = settleNativeAIBudgetAttempt(ctx, tx, id, attempt, dispatched); usageErr != nil {
				return lease, false, usageErr
			}
		}
		if _, e := tx.Exec(ctx, `UPDATE task_executions SET status='failed',error_details='{"code":"TASK_INPUT_INVALID"}',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1`, id); e != nil {
			return lease, false, e
		}
		if _, e := tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1`, id); e != nil {
			return lease, false, e
		}
		if _, e := tx.Exec(ctx, `UPDATE ai_runs SET error_code='TASK_INPUT_INVALID',error_message='Invalid retained task input',finished_at=NOW() WHERE id=$1`, id); e != nil {
			return lease, false, e
		}
		if e := appendNativeRunEvent(ctx, tx, id, "run_failed", Object{"code": "TASK_INPUT_INVALID"}); e != nil {
			return lease, false, e
		}
		return lease, false, tx.Commit(ctx)
	}
	if err = nativeTaskOwner(ctx, tx, input, false); err != nil {
		if isNativeAIRun(text(row["kind"])) {
			attempt := max(int64(1), integer(row["attempt"]))
			dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, id, attempt)
			if usageErr != nil {
				return lease, false, usageErr
			}
			if usageErr = settleNativeAIBudgetAttempt(ctx, tx, id, attempt, dispatched); usageErr != nil {
				return lease, false, usageErr
			}
		}
		if _, e := tx.Exec(ctx, `UPDATE task_executions SET status='cancelled',cancel_requested_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,
			fence_token=fence_token+1,error_details='{"code":"TASK_OWNER_REVOKED"}',updated_at=NOW() WHERE id=$1 AND fence_token<9223372036854775807`, id); e != nil {
			return lease, false, e
		}
		if _, e := tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1`, id); e != nil {
			return lease, false, e
		}
		if _, e := tx.Exec(ctx, `UPDATE ai_runs SET error_code='TASK_OWNER_REVOKED',error_message='Task owner or scope is no longer active',finished_at=NOW(),updated_at=NOW() WHERE id=$1`, id); e != nil {
			return lease, false, e
		}
		if e := appendNativeRunEvent(ctx, tx, id, "run_cancelled", Object{"code": "TASK_OWNER_REVOKED", "attempt": integer(row["attempt"])}); e != nil {
			return lease, false, e
		}
		return lease, false, tx.Commit(ctx)
	}
	attempt := integer(row["attempt"])
	if attempt < 1 {
		attempt = 1
	} else if text(row["status"]) == "running" {
		attempt++
	}
	if attempt > integer(row["max_attempts"]) || integer(row["fence_token"]) == math.MaxInt64 {
		if isNativeAIRun(text(row["kind"])) && integer(row["attempt"]) > 0 {
			dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, id, integer(row["attempt"]))
			if usageErr != nil {
				return lease, false, usageErr
			}
			if usageErr = settleNativeAIBudgetAttempt(ctx, tx, id, integer(row["attempt"]), dispatched); usageErr != nil {
				return lease, false, usageErr
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE task_executions SET status='failed',lease_owner=NULL,lease_expires_at=NULL,error_details='{"code":"ATTEMPTS_EXHAUSTED"}',updated_at=NOW() WHERE id=$1`, id); err != nil {
			return lease, false, err
		}
		if _, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1`, id); err != nil {
			return lease, false, err
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_runs SET error_code='ATTEMPTS_EXHAUSTED',error_message='Execution attempts exhausted',finished_at=NOW() WHERE id=$1`, id); err != nil {
			return lease, false, err
		}
		if err = appendNativeRunEvent(ctx, tx, id, "run_failed", Object{"code": "ATTEMPTS_EXHAUSTED", "attempt": integer(row["attempt"])}); err != nil {
			return lease, false, err
		}
		return lease, false, tx.Commit(ctx)
	}
	if isNativeAIRun(text(row["kind"])) {
		previousAttempt := integer(row["attempt"])
		if text(row["status"]) == "running" && previousAttempt > 0 {
			dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, id, previousAttempt)
			if usageErr != nil {
				return lease, false, usageErr
			}
			if usageErr = settleNativeAIBudgetAttempt(ctx, tx, id, previousAttempt, dispatched); usageErr != nil {
				return lease, false, usageErr
			}
		}
		if err = reserveNativeAIAttempt(ctx, tx, id, input, attempt); err != nil {
			var budgetErr *APIError
			if !errors.As(err, &budgetErr) || !strings.HasPrefix(budgetErr.Code, "AI_BUDGET_") {
				return lease, false, err
			}
			message, _ := jsonText(Object{"code": budgetErr.Code, "message": budgetErr.Message, "retryable": false, "attempt": attempt})
			if _, err = tx.Exec(ctx, `UPDATE task_executions SET status='failed',attempt=$2,lease_owner=NULL,lease_expires_at=NULL,error_details=$3::jsonb,updated_at=NOW() WHERE id=$1`, id, attempt, message); err != nil {
				return lease, false, err
			}
			if _, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1`, id); err != nil {
				return lease, false, err
			}
			if _, err = tx.Exec(ctx, `UPDATE ai_runs SET error_code=$2,error_message=$3,finished_at=NOW(),updated_at=NOW() WHERE id=$1`, id, budgetErr.Code, budgetErr.Message); err != nil {
				return lease, false, err
			}
			if err = appendNativeRunEvent(ctx, tx, id, "run_failed", Object{"code": budgetErr.Code, "message": budgetErr.Message, "attempt": attempt}); err != nil {
				return lease, false, err
			}
			return lease, false, tx.Commit(ctx)
		}
	}
	fence := integer(row["fence_token"]) + 1
	_, err = tx.Exec(ctx, `UPDATE task_executions SET status='running',attempt=$2,fence_token=$3,lease_owner=$4,
		lease_expires_at=clock_timestamp()+make_interval(secs=>$5),last_heartbeat_at=clock_timestamp(),updated_at=NOW() WHERE id=$1`,
		id, attempt, fence, owner, nativeLeaseSeconds)
	if err != nil {
		return lease, false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE task_outbox SET last_dispatched_at=NOW() WHERE id=$1`, outbox["id"]); err != nil {
		return lease, false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_runs SET started_at=NOW(),finished_at=NULL,error_code=NULL,error_message=NULL WHERE id=$1`, id); err != nil {
		return lease, false, err
	}
	if err = appendNativeRunEvent(ctx, tx, id, "run_started", Object{"attempt": attempt}); err != nil {
		return lease, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return lease, false, err
	}
	return nativeTaskLease{ID: id, Kind: text(row["kind"]), Owner: owner, Attempt: attempt, Fence: fence, Input: input}, true, nil
}

var errNativeLeaseLost = errors.New("native task lease lost")

func guardNativeLease(ctx context.Context, tx pgx.Tx, lease nativeTaskLease) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM task_executions WHERE id=$1 AND status='running' AND lease_owner=$2 AND fence_token=$3
		AND cancel_requested_at IS NULL AND lease_expires_at>clock_timestamp() FOR UPDATE`, lease.ID, lease.Owner, lease.Fence).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNativeLeaseLost
	}
	return err
}
func (s *Server) renewNativeLease(ctx context.Context, lease nativeTaskLease) error {
	tag, err := s.DB.Exec(ctx, `UPDATE task_executions SET lease_expires_at=clock_timestamp()+make_interval(secs=>$4),
		last_heartbeat_at=clock_timestamp(),updated_at=NOW() WHERE id=$1 AND status='running' AND lease_owner=$2
		AND fence_token=$3 AND cancel_requested_at IS NULL AND lease_expires_at>clock_timestamp()`,
		lease.ID, lease.Owner, lease.Fence, nativeLeaseSeconds)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errNativeLeaseLost
	}
	return nativeTaskOwner(ctx, s.DB, lease.Input, false)
}
func (s *Server) nativeTaskDelta(ctx context.Context, lease nativeTaskLease, delta string) error {
	if len(delta) > 128*1024 {
		return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "Streaming chunk exceeds budget", false)
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if lease.Input.FamilyID != "" {
		if _, err = lockFamily(ctx, tx, lease.Input.FamilyID); err != nil {
			return err
		}
	}
	if err = guardNativeLease(ctx, tx, lease); err != nil {
		return err
	}
	if err = nativeTaskOwner(ctx, tx, lease.Input, false); err != nil {
		return err
	}
	if err = appendNativeRunEvent(ctx, tx, lease.ID, "text_delta", Object{"text": delta, "attempt": lease.Attempt}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func terminalNativeTask(ctx context.Context, tx pgx.Tx, lease nativeTaskLease, status string, result Object) error {
	raw, err := jsonText(result)
	if err != nil {
		return err
	}
	if len(raw) > 16*1024*1024 {
		return errors.New("task result exceeds size budget")
	}
	_, err = tx.Exec(ctx, `UPDATE task_executions SET status=$2,result_ref=$3::jsonb,error_details=NULL,lease_owner=NULL,
		lease_expires_at=NULL,progress='{"percent":100}',updated_at=NOW() WHERE id=$1`, lease.ID, status, raw)
	if err != nil {
		return err
	}
	dispatch := "closed"
	if status == "awaiting_confirmation" {
		dispatch = "parked"
	}
	_, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state=$2,terminal_at=CASE WHEN $2='closed' THEN NOW() ELSE NULL END WHERE aggregate_id=$1`, lease.ID, dispatch)
	if err != nil {
		return err
	}
	if isNativeAIRun(lease.Kind) {
		dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, lease.ID, lease.Attempt)
		if usageErr != nil {
			return usageErr
		}
		return settleNativeAIBudgetAttempt(ctx, tx, lease.ID, lease.Attempt, dispatched)
	}
	return nil
}
func (s *Server) failNativeTask(ctx context.Context, lease nativeTaskLease, cause error) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Match the account, family, then task order used by submission and claim.
	// This serializes account deletion with an automatic retry reservation.
	if err = lockUser(ctx, tx, lease.Input.UserID); err != nil {
		return err
	}
	if lease.Input.FamilyID != "" {
		if _, err = lockFamily(ctx, tx, lease.Input.FamilyID); err != nil {
			return err
		}
	}
	row, err := one(ctx, tx, `SELECT to_jsonb(t) FROM task_executions t WHERE id=$1 FOR UPDATE`, lease.ID)
	if err != nil {
		return err
	}
	if text(row["lease_owner"]) != lease.Owner || integer(row["fence_token"]) != lease.Fence {
		return errNativeLeaseLost
	}
	if status := text(row["status"]); status != "running" && status != "cancelling" {
		return errNativeLeaseLost
	}
	code, message, retryable := "TASK_EXECUTION_FAILED", "Task execution failed", false
	var provider *nativeProviderError
	if errors.As(cause, &provider) {
		code, message, retryable = provider.Code, provider.Message, provider.Retryable
	}
	var api *APIError
	if errors.As(cause, &api) {
		code, message = api.Code, api.Message
	}
	cancelled := row["cancel_requested_at"] != nil || text(row["status"]) == "cancelling"
	status, event := "failed", "run_failed"
	if cancelled {
		status, event, code, message = "cancelled", "run_cancelled", "TASK_CANCELLED", "Task was cancelled"
	}
	if !cancelled && errors.Is(cause, context.DeadlineExceeded) {
		code, message, retryable = "TASK_TIMEOUT", "Task execution deadline exceeded", true
	}
	if errors.Is(cause, context.Canceled) && !cancelled {
		code, message, retryable = "WORKER_STOPPED", "Worker execution interrupted", true
	}
	retry := !cancelled && retryable && lease.Attempt < integer(row["max_attempts"])
	if isNativeAIRun(lease.Kind) {
		dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, lease.ID, lease.Attempt)
		if usageErr != nil {
			return usageErr
		}
		if usageErr = settleNativeAIBudgetAttempt(ctx, tx, lease.ID, lease.Attempt, dispatched); usageErr != nil {
			return usageErr
		}
		if retry {
			if usageErr = nativeTaskOwner(ctx, tx, lease.Input, false); usageErr != nil {
				retry = false
				code, message, retryable = "TASK_OWNER_REVOKED", "Task owner or scope is no longer active", false
			} else if usageErr = reserveNativeAIAttempt(ctx, tx, lease.ID, lease.Input, lease.Attempt+1); usageErr != nil {
				var budgetErr *APIError
				if !errors.As(usageErr, &budgetErr) || !strings.HasPrefix(budgetErr.Code, "AI_BUDGET_") {
					return usageErr
				}
				retry = false
				code, message, retryable = budgetErr.Code, budgetErr.Message, false
			}
		}
	}
	if retry {
		status, event = "queued", "attempt_restarted"
	}
	details, _ := jsonText(Object{"code": code, "message": message, "retryable": retryable, "attempt": lease.Attempt})
	_, err = tx.Exec(ctx, `UPDATE task_executions SET status=$2,attempt=$3,lease_owner=NULL,lease_expires_at=NULL,error_details=$4::jsonb,updated_at=NOW() WHERE id=$1`,
		lease.ID, status, lease.Attempt+boolInt(retry), details)
	if err != nil {
		return err
	}
	dispatch := "closed"
	if retry {
		dispatch = "active"
	}
	_, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state=$2,next_dispatch_at=clock_timestamp()+make_interval(secs=>$3),
		terminal_at=CASE WHEN $2='closed' THEN NOW() ELSE NULL END WHERE aggregate_id=$1`, lease.ID, dispatch, int32(lease.Attempt*2))
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE ai_runs SET error_code=$2,error_message=$3,finished_at=CASE WHEN $4 THEN NULL ELSE NOW() END,updated_at=NOW() WHERE id=$1`, lease.ID, code, message, retry)
	if err != nil {
		return err
	}
	if lease.Input.SnapshotID != "" && !retry {
		if _, err = tx.Exec(ctx, `UPDATE sync_snapshots SET status='failed',manifest=manifest-'pages',updated_at=NOW() WHERE id=$1`, lease.Input.SnapshotID); err != nil {
			return err
		}
	}
	if err = appendNativeRunEvent(ctx, tx, lease.ID, event, Object{"code": code, "message": message, "attempt": lease.Attempt}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func boolInt(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

// RunWorkerOnce executes one claimed task and joins its sole heartbeat before
// returning. A failed business task is persisted, not mistaken for a crash.
// Database/lease failures remain observable to the process supervisor.
func (s *Server) RunWorkerOnce(ctx context.Context, owner string) (bool, error) {
	lease, found, err := s.claimNativeTask(ctx, owner)
	if err != nil || !found {
		return found, err
	}
	taskCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(4 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-taskCtx.Done():
				return
			case <-ticker.C:
				heartbeat, release := context.WithTimeout(taskCtx, 3*time.Second)
				e := s.renewNativeLease(heartbeat, lease)
				release()
				if e != nil {
					cancel()
					return
				}
			}
		}
	}()
	err = s.executeNativeTask(taskCtx, lease)
	cancel()
	<-done
	if err == nil {
		return true, nil
	}
	finishCtx, release := context.WithTimeout(context.Background(), 5*time.Second)
	defer release()
	if failure := s.failNativeTask(finishCtx, lease, err); failure != nil && !errors.Is(failure, errNativeLeaseLost) {
		return true, failure
	}
	s.Log.Warn("native task did not complete", "taskId", lease.ID, "kind", lease.Kind, "attempt", lease.Attempt)
	return true, nil
}
func (s *Server) RunWorker(ctx context.Context, concurrency int) error {
	if concurrency < 1 || concurrency > 16 {
		return errors.New("worker concurrency must be between 1 and 16")
	}
	var group sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			owner := "go-" + newID()
			for ctx.Err() == nil {
				found, err := s.RunWorkerOnce(ctx, owner)
				if err != nil && ctx.Err() == nil {
					s.Log.Error("native worker database operation failed", "worker", owner)
				}
				if !found || err != nil {
					timer := time.NewTimer(500 * time.Millisecond)
					select {
					case <-ctx.Done():
						timer.Stop()
						return
					case <-timer.C:
					}
				}
			}
		}()
	}
	group.Wait()
	return nil
}

// Reconciliation never starts concurrent unbounded timers. Only this runtime's
// outbox rows are touched; unrelated/legacy workers retain their own state.
func (s *Server) ReconcileNativeTasks(ctx context.Context) (int64, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(tx)
	rows, err := many(ctx, tx, `SELECT to_jsonb(t) FROM task_executions t WHERE
		t.status IN ('queued','running','cancelling') AND t.cancel_requested_at IS NOT NULL
		AND (t.lease_expires_at IS NULL OR t.lease_expires_at<clock_timestamp())
		AND EXISTS(SELECT 1 FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial')
		ORDER BY t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`)
	if err != nil {
		return 0, err
	}
	for _, row := range rows {
		id := text(row["id"])
		if isNativeAIRun(text(row["kind"])) {
			attempt := max(int64(1), integer(row["attempt"]))
			dispatched, usageErr := nativeAIProviderDispatched(ctx, tx, id, attempt)
			if usageErr != nil {
				return 0, usageErr
			}
			if usageErr = settleNativeAIBudgetAttempt(ctx, tx, id, attempt, dispatched); usageErr != nil {
				return 0, usageErr
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE task_executions SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1`, id); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1`, id); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_runs SET finished_at=NOW(),error_code='TASK_CANCELLED' WHERE id=$1`, id); err != nil {
			return 0, err
		}
		if err = appendNativeRunEvent(ctx, tx, id, "run_cancelled", Object{"attempt": integer(row["attempt"])}); err != nil {
			return 0, err
		}
	}
	// Expired snapshot content cannot remain downloadable indefinitely.
	if _, err = tx.Exec(ctx, `UPDATE sync_snapshots SET status='failed',manifest=manifest-'pages',updated_at=NOW()
		WHERE expires_at<clock_timestamp() AND manifest ? 'nativeVersion'`); err != nil {
		return 0, err
	}
	expiredExports, err := tx.Exec(ctx, `WITH expired AS (
		SELECT id FROM task_executions
		WHERE kind='user_data_export' AND status='succeeded'
		  AND result_expires_at<=clock_timestamp() AND result_ref ? 'payload'
		ORDER BY result_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
	)
	UPDATE task_executions t
	SET result_ref=jsonb_build_object('payloadPurged',true),updated_at=clock_timestamp()
	FROM expired e WHERE t.id=e.id`)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	cleaned, err := s.ReconcileNativeObjects(ctx)
	return int64(len(rows)) + expiredExports.RowsAffected() + cleaned, err
}
func (s *Server) RunScheduler(ctx context.Context) error {
	for ctx.Err() == nil {
		step, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := s.ReconcileNativeTasks(step)
		cancel()
		if err != nil && ctx.Err() == nil {
			s.Log.Error("native scheduler reconciliation failed")
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
	return nil
}

func RunNativeRuntime(ctx context.Context, kind string, once bool, log *slog.Logger) error {
	if once {
		budget := 30 * time.Second
		if kind == "worker" {
			budget = 210 * time.Second
		}
		bounded, cancel := context.WithTimeout(ctx, budget)
		defer cancel()
		ctx = bounded
	}
	config, err := LoadConfig()
	if err != nil {
		return err
	}
	start, release := context.WithTimeout(ctx, 10*time.Second)
	server, err := NewServer(start, config, log)
	release()
	if err != nil {
		return err
	}
	defer server.Close()
	server.RegisterBusinessHandlers()
	switch kind {
	case "worker":
		if once {
			_, err = server.RunWorkerOnce(ctx, "go-once-"+newID())
			return err
		}
		n := 2
		if raw := strings.TrimSpace(os.Getenv("GROWDESK_WORKER_CONCURRENCY")); raw != "" {
			n, err = strconv.Atoi(raw)
			if err != nil {
				return fmt.Errorf("invalid worker concurrency")
			}
		}
		return server.RunWorker(ctx, n)
	case "scheduler":
		if once {
			_, err = server.ReconcileNativeTasks(ctx)
			return err
		}
		return server.RunScheduler(ctx)
	default:
		return errors.New("unknown native process")
	}
}
