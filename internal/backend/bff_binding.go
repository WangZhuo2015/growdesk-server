package backend

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func bffBindingConflict() error {
	return apiError(409, "CONCURRENT_MODIFICATION", "BFF binding changed; retry with the current credentials")
}

func sameBffBinding(before, after Object) bool {
	if before == nil || after == nil {
		return before == nil && after == nil
	}
	for _, field := range []string{"id", "user_id", "session_id"} {
		if text(before[field]) != text(after[field]) {
			return false
		}
	}
	return true
}

// Rebinding replaces a credential, not just a pointer to a still-live old
// session. Lock all involved users in sorted order, then device -> BFF, matching
// exchange/revocation. A stale preflight is a retryable conflict, never authority
// to overwrite another binding. Everything, including old revocation, commits
// together so a failed new binding cannot log out the existing session.
func (s *Server) bindBffSession(ctx context.Context, r *Request) (Result, error) {
	secretHash := text(r.Body["sessionSecretHash"])
	password := text(r.Body["password"])
	verified, err := s.verifyCredentials(ctx, strings.ToLower(strings.TrimSpace(text(r.Body["username"]))), password)
	if err != nil {
		return Result{}, err
	}
	before, err := one(ctx, s.DB, "SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1", secretHash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	uid := text(verified["id"])
	users := []string{uid}
	if before != nil && text(before["user_id"]) != uid {
		users = append(users, text(before["user_id"]))
	}
	sort.Strings(users)
	for _, id := range users {
		if err = lockUser(ctx, tx, id); err != nil {
			return Result{}, err
		}
	}
	user, err := one(ctx, tx, "SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(401, "INVALID_CREDENTIALS", "Invalid username or password")
	}
	if err != nil {
		return Result{}, err
	}
	if text(user["password_hash"]) != text(verified["password_hash"]) {
		valid, err := s.checkPassword(ctx, password, text(user["password_hash"]))
		if err != nil {
			return Result{}, err
		}
		if !valid {
			return Result{}, apiError(401, "INVALID_CREDENTIALS", "Invalid username or password")
		}
	}
	if before != nil {
		_, err = one(ctx, tx, "SELECT to_jsonb(d) FROM device_sessions d WHERE id=$1 AND user_id=$2 FOR UPDATE", text(before["session_id"]), text(before["user_id"]))
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, bffBindingConflict()
		}
		if err != nil {
			return Result{}, err
		}
	}
	after, err := one(ctx, tx, "SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1 FOR UPDATE", secretHash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	if !sameBffBinding(before, after) {
		return Result{}, bffBindingConflict()
	}
	if before != nil {
		if _, err = revokeSessionTx(ctx, tx, text(before["user_id"]), text(before["session_id"])); err != nil {
			return Result{}, err
		}
	}
	label := text(r.Body["deviceLabel"])
	if label == "" {
		label = "Web Browser"
	}
	tokens, err := s.createSession(ctx, tx, uid, label, "web")
	if err != nil {
		return Result{}, err
	}
	encrypted, err := s.sealSession(tokens.RefreshToken, "bff:"+secretHash)
	if err != nil {
		return Result{}, err
	}
	now := time.Now().UTC()
	if before == nil {
		// No UPSERT: two different users may race to bind an initially absent
		// secret. Only one INSERT may win; the loser's new session rolls back.
		_, err = tx.Exec(ctx, `INSERT INTO bff_sessions
            (id,session_secret_hash,user_id,session_id,encrypted_refresh_token,rotation_id,
             current_access_token,access_token_expires_at,idle_expires_at,absolute_expires_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
			newID(), secretHash, uid, tokens.SessionID, encrypted, tokens.RotationID,
			tokens.AccessToken, now.Add(600*time.Second), tokens.ExpiresAt, now.Add(30*24*time.Hour))
		if err != nil && normalizedError(err).Status == 409 {
			return Result{}, bffBindingConflict()
		}
	} else {
		_, err = tx.Exec(ctx, `UPDATE bff_sessions SET user_id=$1,session_id=$2,
            encrypted_refresh_token=$3,rotation_id=$4,current_access_token=$5,
            access_token_expires_at=$6,idle_expires_at=$7,absolute_expires_at=$8,
            revoked_at=NULL,updated_at=NOW() WHERE id=$9`,
			uid, tokens.SessionID, encrypted, tokens.RotationID, tokens.AccessToken,
			now.Add(600*time.Second), tokens.ExpiresAt, now.Add(30*24*time.Hour), text(before["id"]))
	}
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"accessToken": tokens.AccessToken, "expiresIn": 600, "user": userDTO(user)})
}
