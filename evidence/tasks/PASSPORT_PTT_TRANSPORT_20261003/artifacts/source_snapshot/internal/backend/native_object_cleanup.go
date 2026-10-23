package backend

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func requireNativeCleanupStore(ctx context.Context, q Querier) error {
	var exists bool
	if err := q.QueryRow(ctx, `SELECT to_regclass('native_go.object_purges') IS NOT NULL`).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return apiError(503, "STORAGE_MIGRATION_REQUIRED", "Apply native storage cleanup migrations explicitly")
	}
	return nil
}
func journalObjectPurge(ctx context.Context, q Querier, family, id, key string, notBefore time.Time) error {
	if !validStorageKey(key) || family == "" || id == "" {
		return errors.New("invalid internal object purge")
	}
	_, err := q.Exec(ctx, `INSERT INTO native_go.object_purges(id,family_id,attachment_id,object_key,not_before)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(object_key) DO UPDATE SET
        not_before=EXCLUDED.not_before,completed_at=NULL,updated_at=NOW()`,
		newID(), family, id, key, notBefore)
	return err
}

// A journal entry survives failure between S3 I/O and the database commit.
// The scheduler protects currently referenced objects and retries cleanup;
// it never enumerates/deletes arbitrary bucket prefixes.
func (s *Server) ReconcileNativeObjects(ctx context.Context) (int64, error) {
	if s.ObjectStore == nil {
		return 0, nil
	}
	if err := requireNativeCleanupStore(ctx, s.DB); err != nil {
		return 0, err
	}
	owner := newID()
	completed := int64(0)
	for i := 0; i < 25; i++ {
		row, err := one(ctx, s.DB, `UPDATE native_go.object_purges p SET lease_owner=$1,lease_until=clock_timestamp()+INTERVAL '30 seconds',attempts=attempts+1,updated_at=NOW()
            WHERE id=(SELECT id FROM native_go.object_purges WHERE completed_at IS NULL AND not_before<=clock_timestamp()
                AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY not_before,id LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING to_jsonb(p)`, owner)
		if errors.Is(err, pgx.ErrNoRows) {
			break
		}
		if err != nil {
			return completed, err
		}
		step, release := context.WithTimeout(ctx, 25*time.Second)
		err = s.purgeJournaledObject(step, row, owner)
		release()
		if err != nil {
			// Logs and persisted retry diagnostics never contain credentials,
			// presigned URLs, SQL parameters or the underlying provider error.
			_, updateErr := s.DB.Exec(ctx, `UPDATE native_go.object_purges SET lease_owner=NULL,lease_until=NULL,
                last_error='STORAGE_CLEANUP_FAILED',not_before=NOW()+INTERVAL '1 minute',updated_at=NOW()
                WHERE id=$1 AND lease_owner=$2`, row["id"], owner)
			if updateErr != nil {
				return completed, updateErr
			}
			return completed, err
		}
		completed++
	}
	return completed, nil
}
func (s *Server) purgeJournaledObject(ctx context.Context, row Object, owner string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Family -> attachment -> journal is the same order as API mutations.
	// A journal lease is claimed and committed before taking these locks.
	var family string
	err = tx.QueryRow(ctx, `SELECT family_id FROM family_sync_states WHERE family_id=$1 FOR UPDATE`, row["family_id"]).Scan(&family)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	attachment, err := one(ctx, tx, `SELECT to_jsonb(a) FROM attachments a WHERE id=$1 FOR UPDATE`, row["attachment_id"])
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var currentOwner string
	if err = tx.QueryRow(ctx, `SELECT lease_owner FROM native_go.object_purges WHERE id=$1 AND completed_at IS NULL FOR UPDATE`, row["id"]).Scan(&currentOwner); err != nil {
		return err
	}
	if currentOwner != owner {
		return errNativeLeaseLost
	}
	referenced := attachment != nil && text(attachment["object_key"]) == text(row["object_key"]) && attachment["deleted_at"] == nil
	keep := referenced && text(attachment["status"]) == "ready"
	if referenced && text(attachment["status"]) == "pending" {
		expires, e := asTime(attachment["expires_at"])
		if e != nil {
			return e
		}
		// Keep an additional grace period beyond every issued PUT capability.
		if expires.Add(time.Hour).After(time.Now()) {
			_, err = tx.Exec(ctx, `UPDATE native_go.object_purges SET not_before=$2,lease_owner=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1`, row["id"], expires.Add(time.Hour))
			if err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		if _, err = tx.Exec(ctx, `UPDATE attachments SET status='failed',updated_at=NOW() WHERE id=$1`, attachment["id"]); err != nil {
			return err
		}
	}
	if !keep {
		if err = s.ObjectStore.remove(ctx, text(row["object_key"])); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.object_purges SET completed_at=NOW(),lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1`, row["id"]); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
