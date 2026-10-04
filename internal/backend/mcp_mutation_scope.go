package backend

import (
	"context"
	"errors"
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
	if err := lockUser(ctx, tx, auth.principal.UserID); err != nil {
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
		var liveSession string
		err = tx.QueryRow(ctx, `SELECT d.id FROM device_sessions d JOIN users u ON u.id=d.user_id
			WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL
			AND d.absolute_expires_at>clock_timestamp() AND u.deleted_at IS NULL FOR UPDATE OF d`, auth.principal.SessionID, auth.principal.UserID).Scan(&liveSession)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, apiError(401, "SESSION_REVOKED", "Session has expired or was revoked")
		}
		if err != nil {
			return 0, err
		}
	}
	var activeToken string
	err = tx.QueryRow(ctx, `SELECT a.token_hash FROM native_go.oauth_access a
		JOIN native_go.oauth_grants g ON g.id=a.grant_id
		JOIN native_go.oauth_clients c ON c.client_id=g.client_id AND c.revoked_at IS NULL
		WHERE a.token_hash=$1 AND a.grant_id=$2 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
		AND g.user_id=$3 AND g.session_id=$4 AND g.family_id=$5 AND g.baby_id=$6
		AND g.audience=$7 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
		FOR SHARE OF a,g`, auth.accessHash, auth.grantID, auth.principal.UserID, auth.principal.SessionID, familyID, babyID, authAudience(auth)).Scan(&activeToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, apiError(401, "UNAUTHORIZED", "MCP OAuth grant has been revoked or expired")
	}
	if err != nil {
		return 0, err
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

func authAudience(auth *mcpAuthContext) string {
	if auth == nil {
		return ""
	}
	return text(auth.claims["aud"])
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
