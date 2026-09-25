package backend

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// All membership mutations serialize on the family row. Authorization done
// before waiting for that row is only a preliminary check, never permission to
// write or return an idempotency receipt after the wait.
func lockMcpMutationScope(ctx context.Context, tx pgx.Tx, auth *mcpAuthContext, babyID, familyID string) (int64, error) {
	if err := validateMcpMutationCredential(auth, babyID); err != nil {
		return 0, err
	}
	cursor, err := lockFamily(ctx, tx, familyID)
	if err != nil {
		return 0, err
	}
	// A token can expire while this request waits for another family writer.
	if err = validateMcpMutationCredential(auth, babyID); err != nil {
		return 0, err
	}
	if auth.principal.SessionID != "" {
		var active bool
		// NOW() is the transaction start, not the time after the lock wait.
		err = tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM device_sessions d JOIN users u ON u.id=d.user_id
			WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL
			AND d.absolute_expires_at>clock_timestamp() AND u.deleted_at IS NULL
		)`, auth.principal.SessionID, auth.principal.UserID).Scan(&active)
		if err != nil {
			return 0, err
		}
		if !active {
			return 0, apiError(401, "SESSION_REVOKED", "Session has expired or was revoked")
		}
	}
	// This also revalidates live user, family and baby tombstones and both roles.
	current, err := babyScope(ctx, tx, auth.principal.UserID, babyID, true)
	if err != nil {
		return 0, err
	}
	if current.FamilyID != familyID {
		return 0, apiError(403, "BABY_SCOPE_MISMATCH", "Baby no longer belongs to the authorized family")
	}
	return cursor, nil
}

func validateMcpMutationCredential(auth *mcpAuthContext, babyID string) error {
	if auth == nil || auth.principal.UserID == "" {
		return apiError(401, "UNAUTHORIZED", "Authentication is required")
	}
	expires, err := auth.claims.GetExpirationTime()
	if err != nil || expires == nil || !time.Now().Before(expires.Time) {
		return apiError(401, "UNAUTHORIZED", "MCP access token has expired")
	}
	if !auth.scopes["baby:write"] && !auth.scopes["app:write"] {
		return apiError(403, "MCP_SCOPE_DENIED", "MCP write scope is required")
	}
	if babyID == "" || (auth.babyID != "" && auth.babyID != babyID) {
		return apiError(403, "BABY_SCOPE_MISMATCH", "MCP token is bound to another baby")
	}
	return nil
}
