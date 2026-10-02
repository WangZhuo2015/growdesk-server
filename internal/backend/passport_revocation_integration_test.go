package backend

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const passportConfirmationTestApplication = "passport-confirmation-test"

type passportConfirmationPG struct {
	serverDB  *pgxpool.Pool
	controlDB *pgxpool.Pool
	monitorDB *pgxpool.Pool
	server    *Server
}

type passportConfirmationFixture struct {
	userID    string
	familyID  string
	babyID    string
	deviceID  string
	principal *PassportPrincipal
}

type passportConfirmationResult struct {
	recordID string
	err      error
}

func TestPassportConfirmationRevocationIntegration(t *testing.T) {
	h := newPassportConfirmationPG(t)

	t.Run("revoked before confirmation is denied", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if _, err := h.controlDB.Exec(ctx, `UPDATE passport_devices SET revoked_at=clock_timestamp() WHERE id=$1`, fx.deviceID); err != nil {
			t.Fatal(err)
		}
		resultID, err := confirmPassportFixture(ctx, h.server, fx)
		requirePassportConfirmationError(t, err, "DEVICE_ACCESS_REVOKED")
		requirePassportRecordCount(t, ctx, h.controlDB, fx, 0)
		if resultID != "" {
			t.Fatalf("denied confirmation returned record id %q", resultID)
		}
	})

	t.Run("expired principal is rejected before database mutation", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		fx.principal.ExpiresAt = time.Now().Add(-time.Second)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		resultID, err := confirmPassportFixture(ctx, h.server, fx)
		requirePassportConfirmationError(t, err, "INVALID_PASSPORT_TOKEN")
		if resultID != "" {
			t.Fatalf("expired confirmation returned record id %q", resultID)
		}
		requirePassportRecordCount(t, ctx, h.controlDB, fx, 0)
	})

	t.Run("current writable baby scope rejects a stale principal family", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		fx.principal.FamilyID = "test_passport_stale_family_" + strings.ReplaceAll(newID(), "-", "")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		resultID, err := confirmPassportFixture(ctx, h.server, fx)
		requirePassportConfirmationError(t, err, "BABY_SCOPE_MISMATCH")
		if resultID != "" {
			t.Fatalf("stale scope confirmation returned record id %q", resultID)
		}
		requirePassportRecordCount(t, ctx, h.controlDB, fx, 0)
	})

	t.Run("revocation wins while confirmation waits for family lock", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()

		familyLock, blockerPID := beginPassportFamilyLock(t, ctx, h.controlDB, fx.familyID)
		committed := false
		defer func() {
			if !committed {
				_ = familyLock.Rollback(context.Background())
			}
		}()

		resultCh := startPassportConfirmation(ctx, h.server, fx)
		_, waitErr := waitForApplicationBlockedBy(ctx, h.monitorDB, passportConfirmationTestApplication, blockerPID)
		if waitErr == nil {
			if _, err := h.controlDB.Exec(ctx, `UPDATE passport_devices SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL`, fx.deviceID); err != nil {
				waitErr = fmt.Errorf("revoke device while confirmation waits: %w", err)
			}
		}
		commitErr := familyLock.Commit(ctx)
		committed = commitErr == nil
		result, resultErr := receivePassportConfirmation(ctx, resultCh)
		if waitErr != nil {
			t.Fatalf("confirmation did not reach the family-lock barrier or revoke failed: %v", waitErr)
		}
		if commitErr != nil {
			t.Fatalf("release family-lock barrier: %v", commitErr)
		}
		if resultErr != nil {
			t.Fatal(resultErr)
		}
		requirePassportConfirmationError(t, result.err, "DEVICE_ACCESS_REVOKED")
		if result.recordID != "" {
			t.Fatalf("denied confirmation returned record id %q", result.recordID)
		}
		requirePassportRecordCount(t, ctx, h.controlDB, fx, 0)
	})

	t.Run("scope revocation while waiting for family lock is rechecked", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()

		familyLock, blockerPID := beginPassportFamilyLock(t, ctx, h.controlDB, fx.familyID)
		committed := false
		defer func() {
			if !committed {
				_ = familyLock.Rollback(context.Background())
			}
		}()

		resultCh := startPassportConfirmation(ctx, h.server, fx)
		_, waitErr := waitForApplicationBlockedBy(ctx, h.monitorDB, passportConfirmationTestApplication, blockerPID)
		if waitErr == nil {
			if _, err := familyLock.Exec(ctx, `UPDATE baby_members SET status='revoked', updated_at=clock_timestamp() WHERE baby_id=$1 AND family_id=$2 AND user_id=$3 AND status='active'`, fx.babyID, fx.familyID, fx.userID); err != nil {
				waitErr = fmt.Errorf("revoke baby membership while confirmation waits: %w", err)
			}
		}
		commitErr := familyLock.Commit(ctx)
		committed = commitErr == nil
		result, resultErr := receivePassportConfirmation(ctx, resultCh)
		if waitErr != nil {
			t.Fatalf("confirmation did not reach the family-lock barrier or scope update failed: %v", waitErr)
		}
		if commitErr != nil {
			t.Fatalf("release family-lock barrier: %v", commitErr)
		}
		if resultErr != nil {
			t.Fatal(resultErr)
		}
		requirePassportConfirmationError(t, result.err, "BABY_ACCESS_DENIED")
		if result.recordID != "" {
			t.Fatalf("denied confirmation returned record id %q", result.recordID)
		}
		requirePassportRecordCount(t, ctx, h.controlDB, fx, 0)
	})

	t.Run("confirmation holds device authorization through commit", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		tableLock, err := h.controlDB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		tableLockCommitted := false
		defer func() {
			if !tableLockCommitted {
				_ = tableLock.Rollback(context.Background())
			}
		}()
		if _, err := tableLock.Exec(ctx, `LOCK TABLE public.feeding_records IN SHARE MODE`); err != nil {
			t.Fatalf("install insert barrier: %v", err)
		}
		blockerPID, err := passportBackendPID(ctx, tableLock)
		if err != nil {
			t.Fatal(err)
		}

		confirmCh := startPassportConfirmation(ctx, h.server, fx)
		confirmPID, waitErr := waitForApplicationBlockedBy(ctx, h.monitorDB, passportConfirmationTestApplication, blockerPID)
		if waitErr != nil {
			_ = tableLock.Rollback(context.Background())
			tableLockCommitted = true
			select {
			case early := <-confirmCh:
				t.Fatalf("confirmation exited before reaching the feeding_records barrier (recordID=%q, confirmation error=%v; barrier error=%v)", early.recordID, early.err, waitErr)
			case <-time.After(time.Second):
				t.Fatalf("confirmation did not reach the feeding_records barrier: %v", waitErr)
			}
		}

		var revokeConn *pgxpool.Conn
		var revokePID int32
		revokeCh := make(chan error, 1)
		if waitErr == nil {
			revokeConn, err = h.controlDB.Acquire(ctx)
			if err == nil {
				revokePID = int32(revokeConn.Conn().PgConn().PID())
				go func() {
					_, execErr := revokeConn.Exec(ctx, `UPDATE passport_devices SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL`, fx.deviceID)
					revokeCh <- execErr
				}()
				waitErr = waitForPIDBlockedBy(ctx, h.monitorDB, revokePID, confirmPID)
			} else {
				waitErr = fmt.Errorf("acquire revoker connection: %w", err)
			}
		}

		commitErr := tableLock.Commit(ctx)
		tableLockCommitted = commitErr == nil
		confirmResult, confirmErr := receivePassportConfirmation(ctx, confirmCh)
		var revokeErr error
		if revokeConn != nil {
			select {
			case revokeErr = <-revokeCh:
			case <-ctx.Done():
				revokeErr = ctx.Err()
			}
			revokeConn.Release()
		}
		if waitErr != nil {
			t.Fatalf("expected revocation UPDATE to wait on the confirmation's device-row share lock: %v", waitErr)
		}
		if commitErr != nil {
			t.Fatalf("release record-insert barrier: %v", commitErr)
		}
		if confirmErr != nil {
			t.Fatal(confirmErr)
		}
		if confirmResult.err != nil {
			t.Fatalf("confirmation should commit before the waiting revocation: %v", confirmResult.err)
		}
		if revokeErr != nil {
			t.Fatalf("revocation should finish after confirmation commits: %v", revokeErr)
		}
		if confirmResult.recordID == "" {
			t.Fatal("successful confirmation returned an empty record id")
		}
		requirePassportRecordCount(t, ctx, h.controlDB, fx, 1)
		var revokedAt *time.Time
		if err := h.controlDB.QueryRow(ctx, `SELECT revoked_at FROM passport_devices WHERE id=$1`, fx.deviceID).Scan(&revokedAt); err != nil {
			t.Fatal(err)
		}
		if revokedAt == nil {
			t.Fatal("waiting revocation did not commit after confirmation")
		}
	})
}

func newPassportConfirmationPG(t *testing.T) *passportConfirmationPG {
	t.Helper()
	rawURL := os.Getenv("TEST_PASSPORT_DATABASE_URL")
	if rawURL == "" {
		if os.Getenv("PASSPORT_REQUIRE_INTEGRATION") == "1" {
			t.Fatal("TEST_PASSPORT_DATABASE_URL is required when PASSPORT_REQUIRE_INTEGRATION=1; refusing to skip the Passport PostgreSQL regression")
		}
		t.Skip("set TEST_PASSPORT_DATABASE_URL to an owned, migrated test_ PostgreSQL database to run Passport revocation integration tests")
	}
	if err := ValidateDatabaseURL(rawURL, true); err != nil {
		t.Fatalf("TEST_PASSPORT_DATABASE_URL failed the loopback test-database guard: %v", err)
	}

	open := func(applicationName string, maxConns int32) *pgxpool.Pool {
		cfg, err := pgxpool.ParseConfig(rawURL)
		if err != nil {
			t.Fatalf("parse TEST_PASSPORT_DATABASE_URL: %v", err)
		}
		cfg.MaxConns = maxConns
		cfg.MinConns = 0
		cfg.ConnConfig.ConnectTimeout = 5 * time.Second
		cfg.ConnConfig.RuntimeParams["application_name"] = applicationName
		cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
		pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
		if err != nil {
			t.Fatalf("connect owned Passport test database: %v", err)
		}
		if err := pool.Ping(context.Background()); err != nil {
			pool.Close()
			t.Fatalf("ping owned Passport test database: %v", err)
		}
		t.Cleanup(pool.Close)
		return pool
	}

	h := &passportConfirmationPG{}
	h.serverDB = open(passportConfirmationTestApplication, 6)
	h.controlDB = open("passport-confirmation-control", 8)
	h.monitorDB = open("passport-confirmation-monitor", 3)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var database, role, owner string
	var superuser bool
	if err := h.controlDB.QueryRow(ctx, `SELECT current_database(), current_user, rolsuper, pg_get_userbyid(datdba)
		FROM pg_database JOIN pg_roles ON rolname=current_user WHERE datname=current_database()`).Scan(&database, &role, &superuser, &owner); err != nil {
		t.Fatalf("verify PostgreSQL test-database ownership: %v", err)
	}
	if superuser || !strings.HasPrefix(database, "test_") || !strings.HasPrefix(role, "test_") || owner != role {
		t.Fatalf("refusing non-owned test database (database=%q role=%q owner=%q superuser=%t)", database, role, owner, superuser)
	}
	for _, table := range []string{"users", "families", "family_members", "babies", "baby_members", "family_sync_states", "passport_devices", "feeding_records"} {
		var exists bool
		if err := h.controlDB.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			t.Fatalf("check migrated test table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("test database is missing public.%s; apply the tracked Prisma migrations and native/migrations/0003_passport.sql", table)
		}
	}
	contract, err := LoadContract()
	if err != nil {
		t.Fatalf("load contract for record confirmation: %v", err)
	}
	h.server = &Server{DB: h.serverDB, Contract: contract}
	return h
}

func newPassportConfirmationFixture(t *testing.T, db *pgxpool.Pool) *passportConfirmationFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seed := strings.ReplaceAll(newID(), "-", "")
	userID, familyID, babyID, deviceID := newID(), newID(), newID(), newID()
	fx := &passportConfirmationFixture{
		userID:   userID,
		familyID: familyID,
		babyID:   babyID,
		deviceID: deviceID,
		principal: &PassportPrincipal{
			DeviceID:    deviceID,
			OwnerUserID: userID,
			FamilyID:    familyID,
			BabyID:      babyID,
			DeviceLabel: "test passport integration device",
			ExpiresAt:   time.Now().Add(time.Hour),
		},
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM families WHERE id=$1`, fx.familyID)
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id=$1`, fx.userID)
	})

	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(tx)
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,username,password_hash,display_name,created_at,updated_at) VALUES($1,$2,'test_hash','Test Passport',clock_timestamp(),clock_timestamp())`, []any{fx.userID, "test_passport_" + seed}},
		{`INSERT INTO families(id,name,created_at,updated_at) VALUES($1,'Test Passport Family',clock_timestamp(),clock_timestamp())`, []any{fx.familyID}},
		{`INSERT INTO family_members(id,family_id,user_id,role,relation,status,created_at,updated_at) VALUES($1,$2,$3,'admin','parent','active',clock_timestamp(),clock_timestamp())`, []any{newID(), fx.familyID, fx.userID}},
		{`INSERT INTO babies(id,family_id,nickname,birth_date,created_at,updated_at) VALUES($1,$2,'Test Baby',DATE '2026-01-01',clock_timestamp(),clock_timestamp())`, []any{fx.babyID, fx.familyID}},
		{`INSERT INTO baby_members(id,family_id,baby_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'admin','active',clock_timestamp(),clock_timestamp())`, []any{newID(), fx.familyID, fx.babyID, fx.userID}},
		{`INSERT INTO family_sync_states(family_id,epoch,cursor,permission_version,created_at,updated_at) VALUES($1,$2,0,1,clock_timestamp(),clock_timestamp())`, []any{fx.familyID, newID()}},
		{`INSERT INTO passport_devices(id,owner_user_id,family_id,baby_id,device_label,credential_hash,created_at,updated_at) VALUES($1,$2,$3,$4,'test passport integration device','test_credential_hash',clock_timestamp(),clock_timestamp())`, []any{fx.deviceID, fx.userID, fx.familyID, fx.babyID}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed owned test tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit owned test tenant: %v", err)
	}
	return fx
}

func confirmPassportFixture(ctx context.Context, server *Server, fx *passportConfirmationFixture) (string, error) {
	runID, actionID, planHash := newID(), newID(), "test_plan_"+newID()
	action := nativeAIAction{
		ActionID: actionID, EntityType: "feeding", Operation: "create", Summary: "Test Passport feeding record",
		Payload: Object{"feedingType": "formula", "amountMl": "140", "occurredAt": time.Now().UTC().Format(time.RFC3339)},
	}
	return server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, actionID, planHash, action, time.Now().Add(2*time.Minute))
}

func startPassportConfirmation(ctx context.Context, server *Server, fx *passportConfirmationFixture) <-chan passportConfirmationResult {
	ch := make(chan passportConfirmationResult, 1)
	go func() {
		recordID, err := confirmPassportFixture(ctx, server, fx)
		ch <- passportConfirmationResult{recordID: recordID, err: err}
	}()
	return ch
}

func receivePassportConfirmation(ctx context.Context, ch <-chan passportConfirmationResult) (passportConfirmationResult, error) {
	select {
	case result := <-ch:
		return result, nil
	case <-ctx.Done():
		return passportConfirmationResult{}, ctx.Err()
	}
}

func beginPassportFamilyLock(t *testing.T, ctx context.Context, db *pgxpool.Pool, familyID string) (pgx.Tx, int32) {
	t.Helper()
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var pid int32
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatal(err)
	}
	var lockedFamily string
	if err := tx.QueryRow(ctx, `SELECT family_id FROM family_sync_states WHERE family_id=$1 FOR UPDATE`, familyID).Scan(&lockedFamily); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("lock test family row: %v", err)
	}
	return tx, pid
}

func passportBackendPID(ctx context.Context, tx pgx.Tx) (int32, error) {
	var pid int32
	err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid)
	return pid, err
}

func waitForApplicationBlockedBy(ctx context.Context, monitor *pgxpool.Pool, applicationName string, blockerPID int32) (int32, error) {
	query := `SELECT pid FROM pg_stat_activity
		WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'
		AND $2=ANY(pg_blocking_pids(pid)) ORDER BY query_start LIMIT 1`
	for {
		var pid int32
		err := monitor.QueryRow(ctx, query, applicationName, blockerPID).Scan(&pid)
		if err == nil {
			return pid, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
		select {
		case <-ctx.Done():
			return 0, fmt.Errorf("timed out waiting for %s to block on PostgreSQL backend %d: %w", applicationName, blockerPID, ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func waitForPIDBlockedBy(ctx context.Context, monitor *pgxpool.Pool, waiterPID, blockerPID int32) error {
	for {
		var blocked bool
		err := monitor.QueryRow(ctx, `SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))
			FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()`, waiterPID, blockerPID).Scan(&blocked)
		if err == nil && blocked {
			return nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("backend %d did not wait on confirmation backend %d: %w", waiterPID, blockerPID, ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func requirePassportConfirmationError(t *testing.T, err error, code string) {
	t.Helper()
	var appErr *APIError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected API error %s, got %v", code, err)
	}
	if appErr.Code != code {
		t.Fatalf("expected API error %s, got %s: %v", code, appErr.Code, err)
	}
}

func requirePassportRecordCount(t *testing.T, ctx context.Context, db *pgxpool.Pool, fx *passportConfirmationFixture, want int) {
	t.Helper()
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM feeding_records WHERE family_id=$1 AND baby_id=$2`, fx.familyID, fx.babyID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("feeding record count = %d, want %d", count, want)
	}
}
