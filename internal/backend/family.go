package backend

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func familyDTO(row Object) Object {
	return Object{"id": row["id"], "name": row["name"], "timeZone": row["timezone"], "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func (s *Server) registerFamilies() {
	s.registerManagement("listFamilies", false, s.listFamilies)
	s.registerManagement("createFamily", false, s.createFamily)
	s.registerManagement("getFamily", false, s.getFamily)
	s.registerManagement("updateFamily", false, s.updateFamily)
	s.registerManagement("createFamilyInvite", false, s.createFamilyInvite)
	s.registerManagement("previewFamilyInvite", true, s.previewFamilyInvite)
	s.registerManagement("joinFamily", false, s.joinFamily)
	s.registerManagement("listFamilyMembers", false, s.listFamilyMembers)
	s.registerManagement("updateFamilyMember", false, s.updateFamilyMember)
	s.registerManagement("removeFamilyMember", false, s.removeFamilyMember)
}

func (s *Server) listFamilies(ctx context.Context, r *Request) (Result, error) {
	rows, err := many(ctx, s.DB, `SELECT to_jsonb(f) FROM families f JOIN family_members m ON m.family_id=f.id
        WHERE m.user_id=$1 AND m.status='active' AND m.deleted_at IS NULL AND f.deleted_at IS NULL
        ORDER BY m.created_at,m.id`, r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}
	result := make([]Object, 0, len(rows))
	for _, row := range rows {
		result = append(result, familyDTO(row))
	}
	return ok(result)
}

func (s *Server) createFamily(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	// Preserve the reference lock order and user-scoped creation boundary.
	if _, err = tx.Exec(ctx, `SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE`, r.Principal.UserID); err != nil {
		return Result{}, err
	}
	now := time.Now().UTC()
	id := newID()
	tz := text(r.Body["timeZone"])
	if r.Body["timeZone"] == nil {
		tz = "Asia/Shanghai"
	}
	row, err := insertObject(ctx, tx, "families", Object{"id": id, "name": r.Body["name"], "timezone": tz, "created_at": now, "updated_at": now})
	if err != nil {
		return Result{}, err
	}
	_, err = insertObject(ctx, tx, "family_members", Object{"id": newID(), "family_id": id, "user_id": r.Principal.UserID, "role": "admin", "relation": "parent", "status": "active", "created_at": now, "updated_at": now})
	if err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, id); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return created(familyDTO(row))
}

func (s *Server) getFamily(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		id := r.Params["id"]
		if _, err := familyRole(ctx, q, r.Principal.UserID, id); err != nil {
			if normalizedError(err).Status == 403 {
				return Result{}, apiError(404, "FAMILY_NOT_FOUND", "Family not found or access denied")
			}
			return Result{}, err
		}
		row, err := one(ctx, q, `SELECT to_jsonb(f) FROM families f WHERE id=$1 AND deleted_at IS NULL`, id)
		if err != nil {
			return Result{}, err
		}
		return ok(familyDTO(row))
	})
}

func (s *Server) updateFamily(ctx context.Context, r *Request) (Result, error) {
	return s.familyMutation(ctx, r, r.Params["id"], func(tx pgx.Tx, role string) (any, error) {
		if err := requireAdmin(role); err != nil {
			return nil, err
		}
		row, err := one(ctx, tx, `SELECT to_jsonb(f) FROM families f WHERE id=$1`, r.Params["id"])
		if err != nil {
			return nil, err
		}
		values := Object{"version": integer(row["version"]) + 1, "updated_at": time.Now().UTC()}
		if value, ok := r.Body["name"]; ok && value != nil {
			values["name"] = value
		}
		if value, ok := r.Body["timeZone"]; ok && value != nil {
			values["timezone"] = value
		}
		row, err = updateColumns(ctx, tx, "families", r.Params["id"], values)
		if err != nil {
			return nil, err
		}
		return familyDTO(row), nil
	})
}

func (s *Server) inviteHash(code string) string {
	secret := s.Config.InvitePepper
	if secret == "" {
		secret = "growdesk-invite-pepper-v1"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.TrimSpace(code)))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) createFamilyInvite(ctx context.Context, r *Request) (Result, error) {
	id := r.Params["id"]
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	role, err := familyRole(ctx, tx, r.Principal.UserID, id)
	if err != nil {
		return Result{}, err
	}
	if err = requireAdmin(role); err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, id); err != nil {
		return Result{}, err
	}
	role, err = familyRole(ctx, tx, r.Principal.UserID, id)
	if err != nil {
		return Result{}, err
	}
	if err = requireAdmin(role); err != nil {
		return Result{}, err
	}
	days := int64(7)
	if value, ok := r.Body["expiresInDays"]; ok {
		days = integer(value)
	}
	code := strings.ToUpper(randomHex(6))
	expires := time.Now().Add(time.Duration(days) * 24 * time.Hour).UTC()
	_, err = tx.Exec(ctx, `INSERT INTO legacy_invite_code_mappings(code_hmac,family_id,key_id,usage_count,max_uses,expires_at,created_at)
        VALUES($1,$2,'v1',0,1,$3,NOW())`, s.inviteHash(code), id, expires)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return created(Object{"inviteCode": code, "expiresAt": iso(expires)})
}

func (s *Server) previewFamilyInvite(ctx context.Context, r *Request) (Result, error) {
	row, err := one(ctx, s.DB, `SELECT jsonb_build_object('familyName',f.name,'expiresAt',i.expires_at,
        'inviterName',COALESCE((SELECT NULLIF(u.display_name,'') FROM family_members m JOIN users u ON u.id=m.user_id
            WHERE m.family_id=f.id AND m.role='admin' AND m.status='active' AND m.deleted_at IS NULL ORDER BY m.created_at,m.id LIMIT 1),'Family Administrator'))
        FROM legacy_invite_code_mappings i JOIN families f ON f.id=i.family_id AND f.deleted_at IS NULL
        WHERE code_hmac=$1 AND revoked_at IS NULL AND expires_at>NOW() AND usage_count<max_uses`, s.inviteHash(r.HTTP.URL.Query().Get("code")))
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "INVITE_NOT_FOUND", "Invitation code is invalid or has expired")
	}
	if err != nil {
		return Result{}, err
	}
	row["expiresAt"] = isoValue(row["expiresAt"])
	return ok(row)
}

func (s *Server) joinFamily(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	hash := s.inviteHash(text(r.Body["inviteCode"]))
	var familyID string
	err = tx.QueryRow(ctx, `SELECT family_id FROM legacy_invite_code_mappings WHERE code_hmac=$1 AND revoked_at IS NULL AND expires_at>NOW() AND usage_count<max_uses`, hash).Scan(&familyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "INVITE_NOT_FOUND", "Invitation code is invalid or has expired")
	}
	if err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	// Conditional consume under the family lock: concurrent joins cannot share
	// a one-use invite. Failed joins roll back the consume and all memberships.
	tag, err := tx.Exec(ctx, `UPDATE legacy_invite_code_mappings SET usage_count=usage_count+1
        WHERE code_hmac=$1 AND revoked_at IS NULL AND expires_at>NOW() AND usage_count<max_uses`, hash)
	if err != nil {
		return Result{}, err
	}
	if tag.RowsAffected() != 1 {
		return Result{}, apiError(404, "INVITE_NOT_FOUND", "Invitation code is invalid or has expired")
	}
	family, err := one(ctx, tx, `SELECT to_jsonb(f) FROM families f WHERE id=$1 AND deleted_at IS NULL`, familyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "FAMILY_NOT_FOUND", "Family not found")
	}
	if err != nil {
		return Result{}, err
	}
	role := "member"
	member, err := one(ctx, tx, `SELECT to_jsonb(m) FROM family_members m WHERE family_id=$1 AND user_id=$2`, familyID, r.Principal.UserID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		_, err = insertObject(ctx, tx, "family_members", Object{"id": newID(), "family_id": familyID, "user_id": r.Principal.UserID, "role": "member", "relation": "parent", "status": "active", "updated_at": time.Now().UTC()})
	case err != nil:
		return Result{}, err
	case text(member["status"]) == "active" && member["deleted_at"] == nil:
		if text(member["role"]) == "admin" {
			role = "admin"
		}
	default:
		_, err = updateColumns(ctx, tx, "family_members", text(member["id"]), Object{"status": "active", "role": "member", "deleted_at": nil, "updated_at": time.Now().UTC()})
	}
	if err != nil {
		return Result{}, err
	}
	if err = bumpPermission(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"family": familyDTO(family), "role": role})
}

func (s *Server) listFamilyMembers(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		familyID := r.Params["id"]
		if _, err := familyRole(ctx, q, r.Principal.UserID, familyID); err != nil {
			return Result{}, err
		}
		rows, err := many(ctx, q, `SELECT jsonb_build_object('id',m.id,'userId',m.user_id,'familyId',m.family_id,'role',m.role,
        'username',u.username,'displayName',u.display_name,'relation',m.relation,'joinedAt',m.created_at)
        FROM family_members m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1 AND m.status='active' AND m.deleted_at IS NULL ORDER BY m.created_at,m.id`, familyID)
		if err != nil {
			return Result{}, err
		}
		for _, row := range rows {
			row["joinedAt"] = isoValue(row["joinedAt"])
		}
		return ok(rows)
	})
}

func activeFamilyMember(ctx context.Context, q Querier, familyID, userID string) (Object, error) {
	row, err := one(ctx, q, `SELECT to_jsonb(m) FROM family_members m JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL
        WHERE m.family_id=$1 AND m.user_id=$2 AND m.status='active' AND m.deleted_at IS NULL`, familyID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiError(404, "MEMBER_NOT_FOUND", "Target family member not found")
	}
	return row, err
}

func protectFamilyAdmin(ctx context.Context, q Querier, familyID, userID string) error {
	var count int
	if err := q.QueryRow(ctx, `SELECT COUNT(*) FROM family_members fm JOIN users u ON u.id=fm.user_id AND u.deleted_at IS NULL
        WHERE fm.family_id=$1 AND fm.user_id<>$2 AND fm.role='admin' AND fm.status='active' AND fm.deleted_at IS NULL`, familyID, userID).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return apiError(409, "LAST_FAMILY_ADMIN_PROTECTION", "Cannot remove or demote the last active family administrator")
	}
	return nil
}

func (s *Server) updateFamilyMember(ctx context.Context, r *Request) (Result, error) {
	familyID, targetID := r.Params["id"], r.Params["userId"]
	return s.familyMutation(ctx, r, familyID, func(tx pgx.Tx, role string) (any, error) {
		if err := requireAdmin(role); err != nil {
			return nil, err
		}
		target, err := activeFamilyMember(ctx, tx, familyID, targetID)
		if err != nil {
			return nil, err
		}
		if text(target["role"]) == "admin" && text(r.Body["role"]) != "admin" {
			if err = protectFamilyAdmin(ctx, tx, familyID, targetID); err != nil {
				return nil, err
			}
		}
		_, err = updateColumns(ctx, tx, "family_members", text(target["id"]), Object{"role": r.Body["role"], "version": integer(target["version"]) + 1, "updated_at": time.Now().UTC()})
		return Object{"success": true}, err
	})
}

func (s *Server) removeFamilyMember(ctx context.Context, r *Request) (Result, error) {
	familyID, targetID := r.Params["id"], r.Params["userId"]
	return s.familyMutation(ctx, r, familyID, func(tx pgx.Tx, role string) (any, error) {
		if targetID != r.Principal.UserID {
			if err := requireAdmin(role); err != nil {
				return nil, err
			}
		}
		target, err := activeFamilyMember(ctx, tx, familyID, targetID)
		if err != nil {
			return nil, err
		}
		if text(target["role"]) == "admin" {
			if err = protectFamilyAdmin(ctx, tx, familyID, targetID); err != nil {
				return nil, err
			}
		}
		babies, err := many(ctx, tx, `SELECT to_jsonb(b) FROM babies b JOIN baby_members m ON m.baby_id=b.id AND m.family_id=b.family_id
            WHERE b.family_id=$1 AND b.deleted_at IS NULL AND m.user_id=$2 AND m.role='admin' AND m.status='active' AND m.deleted_at IS NULL`, familyID, targetID)
		if err != nil {
			return nil, err
		}
		for _, baby := range babies {
			if err = protectBabyAdmin(ctx, tx, familyID, text(baby["id"]), targetID); err != nil {
				return nil, err
			}
		}
		now := time.Now().UTC()
		if _, err = updateColumns(ctx, tx, "family_members", text(target["id"]), Object{"status": "revoked", "deleted_at": now, "updated_at": now, "version": integer(target["version"]) + 1}); err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, `UPDATE baby_members SET status='revoked',deleted_at=$3,updated_at=$3 WHERE family_id=$1 AND user_id=$2 AND status='active'`, familyID, targetID, now)
		return Object{"removed": true}, err
	})
}
