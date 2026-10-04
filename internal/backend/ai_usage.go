package backend

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const aiBudgetUnit = "ai_run_attempt"
const aiBudgetPeriod = "utc_day"

var nativeAIRunKinds = []string{"ai_chat_run", "voice_transcription", "daily_summary_synthesis", "medical_ocr", "growth_ocr"}

type internalAIBudgetPolicy struct {
	Unit, Period                        string
	UserLimit, FamilyLimit, GlobalLimit int64
	PeriodStart                         time.Time
}

func positiveIntSetting(name string, maximum int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if raw == "" || err != nil || value < 1 || value > maximum {
		return 0, apiError(503, "AI_BUDGET_NOT_CONFIGURED", "AI run-attempt budget requires positive server-side limits")
	}
	return value, nil
}

// nativeAIBudgetPolicy intentionally supports a single explicit, non-monetary
// unit and UTC period until a product contract defines token/cost budgets.
func nativeAIBudgetPolicy() (internalAIBudgetPolicy, error) {
	policy := internalAIBudgetPolicy{Unit: strings.TrimSpace(os.Getenv("GROWDESK_AI_BUDGET_UNIT")), Period: strings.TrimSpace(os.Getenv("GROWDESK_AI_BUDGET_PERIOD"))}
	if policy.Unit != aiBudgetUnit || policy.Period != aiBudgetPeriod {
		return policy, apiError(503, "AI_BUDGET_NOT_CONFIGURED", "AI run-attempt budget unit and UTC period must be configured")
	}
	var err error
	if policy.UserLimit, err = positiveIntSetting("GROWDESK_AI_BUDGET_USER_LIMIT", 1_000_000); err != nil {
		return policy, err
	}
	if policy.FamilyLimit, err = positiveIntSetting("GROWDESK_AI_BUDGET_FAMILY_LIMIT", 10_000_000); err != nil {
		return policy, err
	}
	if policy.GlobalLimit, err = positiveIntSetting("GROWDESK_AI_BUDGET_GLOBAL_LIMIT", 100_000_000); err != nil {
		return policy, err
	}
	policy.PeriodStart = time.Now().UTC().Truncate(24 * time.Hour)
	return policy, nil
}

func aiConcurrencyLimit(name string, fallback, maximum int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 || value > maximum {
		return 0, apiError(503, "AI_CONCURRENCY_CONFIG_INVALID", "AI family/global concurrency limits must be positive integers")
	}
	return value, nil
}

func nativeAIConcurrencyPolicy() (familyLimit, globalLimit int64, err error) {
	familyLimit, err = aiConcurrencyLimit("GROWDESK_AI_MAX_ACTIVE_FAMILY_RUNS", 8, 10_000)
	if err != nil {
		return 0, 0, err
	}
	globalLimit, err = aiConcurrencyLimit("GROWDESK_AI_MAX_ACTIVE_GLOBAL_RUNS", 64, 100_000)
	return familyLimit, globalLimit, err
}

func isNativeAIRun(kind string) bool {
	for _, candidate := range nativeAIRunKinds {
		if kind == candidate {
			return true
		}
	}
	return false
}

type aiBudgetScope struct {
	Type, ID string
	Limit    int64
}

// lockNativeAIBudgetScopes applies the same advisory lock order to reservations,
// settlements, and account-deletion cleanup.
func lockNativeAIBudgetScopes(ctx context.Context, tx pgx.Tx, period time.Time, familyID, userID string) error {
	scopes := []aiBudgetScope{{Type: "global", ID: "all"}}
	if familyID != "" {
		scopes = append(scopes, aiBudgetScope{Type: "family", ID: familyID})
	}
	scopes = append(scopes, aiBudgetScope{Type: "user", ID: userID})
	for _, scope := range scopes {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,73651))`, "ai-budget:"+scope.Type+":"+scope.ID+":"+period.UTC().Format("2006-01-02")); err != nil {
			return err
		}
	}
	return nil
}

// lockActiveAIUsageOwner serializes ledger creation with account deletion and
// refuses new provider or MCP usage after the owner has been soft-deleted.
func lockActiveAIUsageOwner(ctx context.Context, tx pgx.Tx, userID string) error {
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	var active string
	err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, userID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiError(401, "UNAUTHORIZED", "Account is no longer active")
	}
	return err
}

// purgeDeletedUserAIUsage removes owner-scoped reporting rows and releases
// reservations that were never dispatched. Family/global settled units remain
// because they record work already sent to a provider.
func purgeDeletedUserAIUsage(ctx context.Context, tx pgx.Tx, userID string) error {
	rows, err := tx.Query(ctx, `SELECT DISTINCT period_start::text,COALESCE(family_id,'') FROM native_go.ai_budget_reservations
		WHERE user_id=$1 AND status='reserved' ORDER BY 1,2`, userID)
	if err != nil {
		return err
	}
	type budgetPeriodScope struct{ period, family string }
	periodScopes := []budgetPeriodScope{}
	for rows.Next() {
		var item budgetPeriodScope
		if err = rows.Scan(&item.period, &item.family); err != nil {
			rows.Close()
			return err
		}
		periodScopes = append(periodScopes, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range periodScopes {
		period, parseErr := time.Parse("2006-01-02", item.period)
		if parseErr != nil {
			return parseErr
		}
		if err = lockNativeAIBudgetScopes(ctx, tx, period, item.family, userID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `WITH pending AS (
		SELECT period_start,unit,
			count(*) FILTER (WHERE status='reserved')::bigint AS reserved_count,
			count(*) FILTER (WHERE status='reserved' AND EXISTS (
				SELECT 1 FROM native_go.ai_provider_attempts p WHERE p.run_id=r.run_id AND p.attempt=r.attempt
			))::bigint AS dispatched_count
		FROM native_go.ai_budget_reservations r WHERE user_id=$1 GROUP BY period_start,unit
	)
	UPDATE native_go.ai_budget_windows w SET reserved_units=GREATEST(0,w.reserved_units-p.reserved_count),
		settled_units=w.settled_units+p.dispatched_count,updated_at=clock_timestamp()
	FROM pending p WHERE w.scope_type='global' AND w.scope_id='all' AND w.period_start=p.period_start AND w.unit=p.unit`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `WITH pending AS (
		SELECT family_id,period_start,unit,
			count(*) FILTER (WHERE status='reserved')::bigint AS reserved_count,
			count(*) FILTER (WHERE status='reserved' AND EXISTS (
				SELECT 1 FROM native_go.ai_provider_attempts p WHERE p.run_id=r.run_id AND p.attempt=r.attempt
			))::bigint AS dispatched_count
		FROM native_go.ai_budget_reservations r WHERE user_id=$1 AND family_id IS NOT NULL GROUP BY family_id,period_start,unit
	)
	UPDATE native_go.ai_budget_windows w SET reserved_units=GREATEST(0,w.reserved_units-p.reserved_count),
		settled_units=w.settled_units+p.dispatched_count,updated_at=clock_timestamp()
	FROM pending p WHERE w.scope_type='family' AND w.scope_id=p.family_id AND w.period_start=p.period_start AND w.unit=p.unit`, userID); err != nil {
		return err
	}
	for _, statement := range []string{
		`DELETE FROM native_go.mcp_usage_calls WHERE user_id=$1`,
		`DELETE FROM native_go.ai_provider_attempts WHERE user_id=$1`,
		`DELETE FROM native_go.ai_budget_reservations WHERE user_id=$1`,
		`DELETE FROM native_go.ai_budget_windows WHERE scope_type='user' AND scope_id=$1`,
	} {
		if _, err := tx.Exec(ctx, statement, userID); err != nil {
			return err
		}
	}
	return nil
}

func reserveNativeAIAttempt(ctx context.Context, tx pgx.Tx, runID string, input nativeTaskInput, attempt int64) error {
	policy, err := nativeAIBudgetPolicy()
	if err != nil {
		return err
	}
	if attempt < 1 {
		return errors.New("invalid AI budget attempt")
	}
	var existing string
	err = tx.QueryRow(ctx, `SELECT status FROM native_go.ai_budget_reservations WHERE run_id=$1 AND attempt=$2`, runID, attempt).Scan(&existing)
	if err == nil {
		if existing == "reserved" {
			return nil
		}
		return apiError(409, "AI_BUDGET_RESERVATION_CLOSED", "This AI run attempt has already released its budget reservation")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	scopes := []aiBudgetScope{{Type: "global", ID: "all", Limit: policy.GlobalLimit}}
	if input.FamilyID != "" {
		scopes = append(scopes, aiBudgetScope{Type: "family", ID: input.FamilyID, Limit: policy.FamilyLimit})
	}
	scopes = append(scopes, aiBudgetScope{Type: "user", ID: input.UserID, Limit: policy.UserLimit})
	if err = lockNativeAIBudgetScopes(ctx, tx, policy.PeriodStart, input.FamilyID, input.UserID); err != nil {
		return err
	}
	for _, scope := range scopes {
		if _, err = tx.Exec(ctx, `INSERT INTO native_go.ai_budget_windows(scope_type,scope_id,period_start,unit,limit_value)
			VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope_type,scope_id,period_start,unit)
			DO UPDATE SET limit_value=EXCLUDED.limit_value,updated_at=clock_timestamp()`, scope.Type, scope.ID, policy.PeriodStart, policy.Unit, scope.Limit); err != nil {
			return err
		}
		tag, updateErr := tx.Exec(ctx, `UPDATE native_go.ai_budget_windows SET reserved_units=reserved_units+1,updated_at=clock_timestamp()
			WHERE scope_type=$1 AND scope_id=$2 AND period_start=$3 AND unit=$4 AND reserved_units+settled_units<limit_value`,
			scope.Type, scope.ID, policy.PeriodStart, policy.Unit)
		if updateErr != nil {
			return updateErr
		}
		if tag.RowsAffected() != 1 {
			return apiError(429, "AI_BUDGET_EXCEEDED", "The configured AI run-attempt budget is exhausted")
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO native_go.ai_budget_reservations(id,run_id,user_id,family_id,attempt,period_start,unit,status)
		VALUES($1,$2,$3,NULLIF($4,''),$5,$6,$7,'reserved')`, newID(), runID, input.UserID, input.FamilyID, attempt, policy.PeriodStart, policy.Unit)
	return err
}

func settleNativeAIBudgetAttempt(ctx context.Context, tx pgx.Tx, runID string, attempt int64, dispatched bool) error {
	var userID, familyID, periodStart, unit, status string
	err := tx.QueryRow(ctx, `SELECT user_id,COALESCE(family_id,''),period_start::text,unit,status FROM native_go.ai_budget_reservations
		WHERE run_id=$1 AND attempt=$2`, runID, attempt).Scan(&userID, &familyID, &periodStart, &unit, &status)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && status != "reserved" {
		return nil
	}
	if err != nil {
		return err
	}
	period, err := time.Parse("2006-01-02", periodStart)
	if err != nil {
		return err
	}
	if err = lockNativeAIBudgetScopes(ctx, tx, period, familyID, userID); err != nil {
		return err
	}
	err = tx.QueryRow(ctx, `SELECT user_id,COALESCE(family_id,''),period_start::text,unit,status FROM native_go.ai_budget_reservations
		WHERE run_id=$1 AND attempt=$2 FOR UPDATE`, runID, attempt).Scan(&userID, &familyID, &periodStart, &unit, &status)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && status != "reserved" {
		return nil
	}
	if err != nil {
		return err
	}
	scopes := []aiBudgetScope{{Type: "global", ID: "all"}}
	if familyID != "" {
		scopes = append(scopes, aiBudgetScope{Type: "family", ID: familyID})
	}
	scopes = append(scopes, aiBudgetScope{Type: "user", ID: userID})
	for _, scope := range scopes {
		settledDelta := 0
		if dispatched {
			settledDelta = 1
		}
		tag, e := tx.Exec(ctx, `UPDATE native_go.ai_budget_windows SET reserved_units=GREATEST(0,reserved_units-1),
			settled_units=settled_units+$5,updated_at=clock_timestamp()
			WHERE scope_type=$1 AND scope_id=$2 AND period_start=$3 AND unit=$4`, scope.Type, scope.ID, period, unit, settledDelta)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("missing AI budget window for %s scope", scope.Type)
		}
	}
	next := "released"
	if dispatched {
		next = "settled"
	}
	_, err = tx.Exec(ctx, `UPDATE native_go.ai_budget_reservations SET status=$3,settled_at=clock_timestamp() WHERE run_id=$1 AND attempt=$2`, runID, attempt, next)
	return err
}

func nativeAIProviderDispatched(ctx context.Context, q Querier, runID string, attempt int64) (bool, error) {
	var dispatched bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.ai_provider_attempts WHERE run_id=$1 AND attempt=$2)`, runID, attempt).Scan(&dispatched)
	return dispatched, err
}

// nativeAIProviderRetryRisk reports provider work whose result or billing
// outcome is not safe to replay automatically. attempt=0 inspects the whole
// run; a positive attempt narrows the check to one worker lease.
func nativeAIProviderRetryRisk(ctx context.Context, q Querier, runID string, attempt int64) (risky, reported, unknown bool, err error) {
	err = q.QueryRow(ctx, `SELECT
		COALESCE(bool_or(status IN ('dispatched','reported','unknown')),false),
		COALESCE(bool_or(status='reported'),false),
		COALESCE(bool_or(status IN ('dispatched','unknown')),false)
		FROM native_go.ai_provider_attempts WHERE run_id=$1 AND ($2::bigint IS NULL OR attempt=$2)`,
		runID, nullableAttempt(attempt)).Scan(&risky, &reported, &unknown)
	return
}

func nullableAttempt(attempt int64) any {
	if attempt <= 0 {
		return nil
	}
	return attempt
}

func nativeProviderKnownRejected(errorCode string) bool {
	switch errorCode {
	case "AI_PROVIDER_RATE_LIMITED", "AI_PROVIDER_AUTH_FAILED", "AI_PROVIDER_REQUEST_REJECTED":
		return true
	default:
		return false
	}
}

type nativeUsageTracker struct {
	server *Server
	lease  nativeTaskLease
	phase  string
}

type nativeUsageTrackerContextKey struct{}

func withNativeUsageTracker(ctx context.Context, server *Server, lease nativeTaskLease, phase string) context.Context {
	return context.WithValue(ctx, nativeUsageTrackerContextKey{}, nativeUsageTracker{server: server, lease: lease, phase: phase})
}

func beginNativeProviderAttempt(ctx context.Context, provider, model string) (string, error) {
	tracker, ok := ctx.Value(nativeUsageTrackerContextKey{}).(nativeUsageTracker)
	if !ok || tracker.server == nil {
		return "", nil
	}
	if provider == "" {
		provider = "unknown"
	}
	tx, err := tracker.server.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)
	if err = lockActiveAIUsageOwner(ctx, tx, tracker.lease.Input.UserID); err != nil {
		return "", err
	}
	if tracker.lease.Input.FamilyID != "" {
		if _, err = lockFamily(ctx, tx, tracker.lease.Input.FamilyID); err != nil {
			return "", err
		}
	}
	if err = nativeTaskOwner(ctx, tx, tracker.lease.Input, false); err != nil {
		return "", err
	}
	if err = guardNativeLease(ctx, tx, tracker.lease); err != nil {
		return "", err
	}
	var reservation string
	err = tx.QueryRow(ctx, `SELECT status FROM native_go.ai_budget_reservations WHERE run_id=$1 AND attempt=$2 FOR UPDATE`, tracker.lease.ID, tracker.lease.Attempt).Scan(&reservation)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && reservation != "reserved" {
		return "", apiError(429, "AI_BUDGET_RESERVATION_MISSING", "An active AI run-attempt budget reservation is required before provider dispatch")
	}
	if err != nil {
		return "", err
	}
	id := newID()
	tag, err := tx.Exec(ctx, `INSERT INTO native_go.ai_provider_attempts(id,user_id,run_id,family_id,baby_id,attempt,phase,provider,model,status,usage_state,cost_state)
		VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,$8,NULLIF($9,''),'dispatched','unknown','unpriced')
		ON CONFLICT(run_id,attempt,phase) DO NOTHING`, id, tracker.lease.Input.UserID, tracker.lease.ID, tracker.lease.Input.FamilyID, tracker.lease.Input.BabyID, tracker.lease.Attempt, tracker.phase, provider, model)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		if err = tx.QueryRow(ctx, `SELECT id FROM native_go.ai_provider_attempts WHERE run_id=$1 AND attempt=$2 AND phase=$3`, tracker.lease.ID, tracker.lease.Attempt, tracker.phase).Scan(&id); err != nil {
			return "", err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func providerTokenCount(usage Object, keys ...string) *int64 {
	for _, key := range keys {
		value, ok := usage[key]
		if !ok || value == nil {
			continue
		}
		var count int64
		switch number := value.(type) {
		case int:
			count = int64(number)
		case int64:
			count = number
		case float64:
			if number < 0 || number > 9_223_372_036_854_775_807 || number != float64(int64(number)) {
				continue
			}
			count = int64(number)
		case string:
			parsed, err := strconv.ParseInt(number, 10, 64)
			if err != nil {
				continue
			}
			count = parsed
		default:
			parsed, err := strconv.ParseInt(fmt.Sprint(value), 10, 64)
			if err != nil {
				continue
			}
			count = parsed
		}
		if count >= 0 {
			return &count
		}
	}
	return nil
}

func finishNativeProviderAttempt(ctx context.Context, id string, usage Object, succeeded bool, errorCode string) error {
	if id == "" {
		return nil
	}
	tracker, ok := ctx.Value(nativeUsageTrackerContextKey{}).(nativeUsageTracker)
	if !ok || tracker.server == nil {
		return nil
	}
	persistCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	input := providerTokenCount(usage, "input_tokens", "prompt_tokens")
	output := providerTokenCount(usage, "output_tokens", "completion_tokens")
	total := providerTokenCount(usage, "total_tokens")
	usageState := "unknown"
	if input != nil && output != nil {
		usageState = "reported"
		if total == nil {
			value := *input + *output
			total = &value
		}
	} else if input != nil || output != nil || total != nil {
		usageState = "partial"
	}
	status := "unknown"
	if succeeded {
		status = "reported"
	} else if nativeProviderKnownRejected(errorCode) {
		status = "failed"
	}
	var errValue any
	if errorCode != "" {
		errValue = errorCode
	}
	tag, err := tracker.server.DB.Exec(persistCtx, `UPDATE native_go.ai_provider_attempts SET status=$2,usage_state=$3,
		input_tokens=$4,output_tokens=$5,total_tokens=$6,cost_micros=NULL,cost_state='unpriced',error_code=$7,settled_at=clock_timestamp()
		WHERE id=$1 AND status='dispatched'`, id, status, usageState, input, output, total, errValue)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Account deletion intentionally removes in-flight rows; a late worker
		// must never recreate personal usage after that cleanup commits.
		return nil
	}
	return nil
}

func unavailableAIUsageBudget() Object {
	return Object{"availability": "not_configured", "unit": aiBudgetUnit, "period": aiBudgetPeriod, "limit": nil, "reservedUnits": nil, "settledUnits": nil, "remainingUnits": nil}
}
