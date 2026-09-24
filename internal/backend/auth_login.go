package backend

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

// Password recovery, password changes, revocation and login share the same
// user lock. Verification outside the transaction is only a preflight: it
// cannot authorize credentials created after a concurrent password reset.
func (s *Server) login(ctx context.Context, r *Request) (Result, error) {
	password := text(r.Body["password"])
	verified, err := s.verifyCredentials(ctx, text(r.Body["username"]), password)
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	uid := text(verified["id"])
	if err = lockUser(ctx, tx, uid); err != nil {
		return Result{}, err
	}
	user, err := one(ctx, tx, "SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(401, "INVALID_CREDENTIALS", "Invalid username or password")
	}
	if err != nil {
		return Result{}, err
	}
	stored := text(user["password_hash"])
	if stored != text(verified["password_hash"]) {
		// Another successful login may have rehashed the SAME password. Do not
		// spuriously reject it, but never trust the old verification after reset.
		valid, err := s.checkPassword(ctx, password, stored)
		if err != nil {
			return Result{}, err
		}
		if !valid {
			return Result{}, apiError(401, "INVALID_CREDENTIALS", "Invalid username or password")
		}
	}
	cost, err := bcrypt.Cost([]byte(stored))
	if err != nil {
		return Result{}, apiError(401, "INVALID_CREDENTIALS", "Invalid username or password")
	}
	if cost < 10 || strings.HasPrefix(stored, "$2a$") {
		hash, err := s.passwordHash(ctx, password, 12)
		if err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE users SET password_hash=$1,
            password_hash_version=password_hash_version+1,password_hash_needs_rehash=false,updated_at=NOW()
            WHERE id=$2`, hash, uid); err != nil {
			return Result{}, err
		}
	}
	tokens, err := s.createSession(ctx, tx, uid, text(r.Body["deviceLabel"]), "")
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"accessToken": tokens.AccessToken, "refreshToken": tokens.RefreshToken,
		"expiresIn": 600, "sessionId": tokens.SessionID, "user": userDTO(user)})
}
