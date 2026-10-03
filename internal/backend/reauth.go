package backend

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const recentReauthenticationWindow = 5 * time.Minute

func sessionCreatedWithinReauthenticationWindow(createdAt, now time.Time) bool {
	return !createdAt.Before(now.Add(-recentReauthenticationWindow)) && !createdAt.After(now)
}

// requireRecentSessionReauthentication checks the creation time of the
// authenticated device session itself. Refreshing an access token updates
// last_seen_at only and must not extend this window.
func requireRecentSessionReauthentication(ctx context.Context, q Querier, userID, sessionID string) error {
	var createdAt, now time.Time
	err := q.QueryRow(ctx, `SELECT created_at,statement_timestamp() FROM device_sessions
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND absolute_expires_at>statement_timestamp()
		FOR UPDATE`, sessionID, userID).Scan(&createdAt, &now)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiError(401, "SESSION_REVOKED", "Session has expired or was revoked")
	}
	if err != nil {
		return err
	}
	if !sessionCreatedWithinReauthenticationWindow(createdAt, now) {
		return apiError(403, "REAUTH_REQUIRED", "Please sign in again to continue this action")
	}
	return nil
}
