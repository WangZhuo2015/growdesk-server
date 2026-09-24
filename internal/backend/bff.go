package backend

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

var rawRefreshPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (s *Server) bffExchange(ctx context.Context, r *Request) (Result, error) {
	secretHash := text(r.Body["sessionSecretHash"])
	if text(r.Body["username"]) != "" && text(r.Body["password"]) != "" {
		return s.bindBffSession(ctx, r)
	}
	if text(r.Body["legacyAuthToken"]) != "" {
		return s.bindBffLegacySession(ctx, r)
	}
	pre, err := one(ctx, s.DB, "SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1", secretHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(401, "BFF_SESSION_NOT_FOUND", "BFF session does not exist or has expired")
	}
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	uid, sid := text(pre["user_id"]), text(pre["session_id"])
	if supplied := text(r.Body["userId"]); supplied != "" && supplied != uid {
		return Result{}, apiError(401, "BFF_SESSION_USER_MISMATCH", "BFF session user identity mismatch")
	}
	if err = lockUser(ctx, tx, uid); err != nil {
		return Result{}, err
	}
	session, err := liveSession(ctx, tx, uid, sid)
	if err != nil {
		if normalizedError(err).Status == 401 {
			return Result{}, apiError(401, "BFF_SESSION_EXPIRED", "BFF session has been revoked or expired")
		}
		return Result{}, err
	}
	bff, err := one(ctx, tx, "SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1 FOR UPDATE", secretHash)
	if err != nil {
		return Result{}, err
	}
	if text(bff["user_id"]) != uid || text(bff["session_id"]) != sid {
		return Result{}, apiError(401, "BFF_SESSION_USER_MISMATCH", "BFF session user identity mismatch")
	}
	idle, err := asTime(bff["idle_expires_at"])
	if err != nil {
		return Result{}, err
	}
	absolute, err := asTime(bff["absolute_expires_at"])
	if err != nil {
		return Result{}, err
	}
	if bff["revoked_at"] != nil || !idle.After(time.Now()) || !absolute.After(time.Now()) {
		return Result{}, apiError(401, "BFF_SESSION_EXPIRED", "BFF session has been revoked or expired")
	}
	user, err := one(ctx, tx, "SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL", uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(401, "USER_DELETED", "User account is no longer active")
	}
	if err != nil {
		return Result{}, err
	}
	if token := text(bff["current_access_token"]); token != "" && bff["access_token_expires_at"] != nil {
		expires, err := asTime(bff["access_token_expires_at"])
		if err != nil {
			return Result{}, err
		}
		if remaining := int(time.Until(expires).Seconds()); remaining > 60 {
			if err = tx.Commit(ctx); err != nil {
				return Result{}, err
			}
			return ok(Object{"accessToken": token, "expiresIn": remaining, "user": userDTO(user)})
		}
	}
	stored := text(bff["encrypted_refresh_token"])
	var raw string
	if rawRefreshPattern.MatchString(stored) {
		// The reference stores plaintext despite the column name. A successful
		// refresh upgrades it in this transaction; new values are never plaintext.
		raw = stored
	} else {
		raw, err = s.openSession(stored, "bff:"+secretHash)
		if err != nil {
			return Result{}, apiError(503, "SESSION_KEY_UNAVAILABLE", "Session cannot be decrypted with the configured key")
		}
	}
	result, commitError, err := s.rotateLocked(ctx, tx, uid, session, raw, text(bff["rotation_id"]))
	if err != nil {
		if commitError {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return Result{}, commitErr
			}
		}
		return Result{}, err
	}
	encrypted, err := s.sealSession(text(result["refreshToken"]), "bff:"+secretHash)
	if err != nil {
		return Result{}, err
	}
	newIdle := time.Now().UTC().Add(7 * 24 * time.Hour)
	if absolute.Before(newIdle) {
		newIdle = absolute
	}
	_, err = tx.Exec(ctx, `UPDATE bff_sessions SET encrypted_refresh_token=$1,rotation_id=$2,
        current_access_token=$3,access_token_expires_at=$4,idle_expires_at=$5,updated_at=NOW() WHERE id=$6`,
		encrypted, text(result["rotationId"]), text(result["accessToken"]), time.Now().UTC().Add(600*time.Second), newIdle, text(bff["id"]))
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"accessToken": result["accessToken"], "expiresIn": result["expiresIn"], "user": userDTO(user)})
}

func (s *Server) bffRevoke(ctx context.Context, r *Request) (Result, error) {
	hash := text(r.Body["sessionSecretHash"])
	pre, err := one(ctx, s.DB, "SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1", hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ok(Object{"success": true})
	}
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	uid := text(pre["user_id"])
	if err = lockUser(ctx, tx, uid); err != nil {
		return Result{}, err
	}
	// Same order as refresh: user -> device -> BFF -> credentials.
	if _, err = one(ctx, tx, "SELECT to_jsonb(d) FROM device_sessions d WHERE id=$1 AND user_id=$2 FOR UPDATE", text(pre["session_id"]), uid); err != nil {
		return Result{}, err
	}
	row, err := one(ctx, tx, "SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1 FOR UPDATE", hash)
	if err != nil {
		return Result{}, err
	}
	if !sameBffBinding(pre, row) {
		return Result{}, bffBindingConflict()
	}
	if _, err = tx.Exec(ctx, "UPDATE bff_sessions SET revoked_at=NOW(),updated_at=NOW() WHERE id=$1", text(row["id"])); err != nil {
		return Result{}, err
	}
	if _, err = revokeSessionTx(ctx, tx, uid, text(row["session_id"])); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"success": true})
}
