package backend

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

func babyDTO(row Object) Object {
	gender := "other"
	switch text(row["gender"]) {
	case "female":
		gender = "girl"
	case "male":
		gender = "boy"
	}
	var weeks, days any
	if row["gestational_age"] != nil {
		age := integer(row["gestational_age"])
		weeks, days = age/7, age%7
	}
	return Object{"id": row["id"], "familyId": row["family_id"], "name": row["nickname"], "birthDate": dateValue(row["birth_date"]), "gender": gender,
		"avatarUrl": row["avatar_url"], "gestationalWeeks": weeks, "gestationalDays": days, "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}
func dbGender(value any) string {
	switch text(value) {
	case "girl":
		return "female"
	case "boy":
		return "male"
	default:
		return "unspecified"
	}
}

func (s *Server) registerBabies() {
	s.registerManagement("listFamilyBabies", false, s.listFamilyBabies)
	s.registerManagement("createFamilyBaby", false, s.createFamilyBaby)
	s.registerManagement("getBaby", false, s.getBaby)
	s.registerManagement("updateBaby", false, s.updateBaby)
	s.registerManagement("listBabyMembers", false, s.listBabyMembers)
	s.registerManagement("addBabyMember", false, s.addBabyMember)
	s.registerManagement("removeBabyMember", false, s.removeBabyMember)
}

func (s *Server) listFamilyBabies(ctx context.Context, r *Request) (Result, error) {
	familyID := r.Params["id"]
	if _, err := familyRole(ctx, s.DB, r.Principal.UserID, familyID); err != nil {
		return Result{}, err
	}
	rows, err := many(ctx, s.DB, `SELECT to_jsonb(b) FROM babies b JOIN baby_members m ON m.baby_id=b.id AND m.family_id=b.family_id
        WHERE b.family_id=$1 AND b.deleted_at IS NULL AND m.user_id=$2 AND m.status='active' AND m.deleted_at IS NULL ORDER BY b.created_at,b.id`, familyID, r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}
	result := make([]Object, 0, len(rows))
	for _, row := range rows {
		result = append(result, babyDTO(row))
	}
	return ok(result)
}

var avatarPath = regexp.MustCompile(`(?i)^/api/attachments/([a-f0-9-]{36})$`)

func verifyAvatar(ctx context.Context, tx pgx.Tx, value any, familyID, babyID, userID string) error {
	if value == nil || text(value) == "" {
		return nil
	}
	match := avatarPath.FindStringSubmatch(text(value))
	if match == nil {
		return apiError(422, "INVALID_AVATAR", "Use an uploaded avatar attachment")
	}
	row, err := one(ctx, tx, `SELECT to_jsonb(a) FROM attachments a WHERE id=$1 AND family_id=$2 AND purpose='avatar' AND status='ready'
        AND deleted_at IS NULL AND (baby_id=$3 OR (baby_id IS NULL AND uploader_id=$4)) FOR UPDATE`, match[1], familyID, babyID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiError(403, "AVATAR_ACCESS_DENIED", "Avatar attachment is not available for this baby")
	}
	if err != nil {
		return err
	}
	if row["baby_id"] == nil {
		_, err = tx.Exec(ctx, `UPDATE attachments SET baby_id=$2,updated_at=NOW() WHERE id=$1`, match[1], babyID)
	}
	return err
}

func (s *Server) createFamilyBaby(ctx context.Context, r *Request) (Result, error) {
	familyID := r.Params["id"]
	result, err := s.familyMutation(ctx, r, familyID, func(tx pgx.Tx, role string) (any, error) {
		if role == "viewer" {
			return nil, apiError(403, "FORBIDDEN", "Viewer role cannot create babies in family")
		}
		birth, err := asTime(r.Body["birthDate"])
		if err != nil {
			return nil, invalid("Invalid birth date")
		}
		var age any
		if r.Body["gestationalWeeks"] != nil {
			age = integer(r.Body["gestationalWeeks"])*7 + integer(r.Body["gestationalDays"])
		}
		id := newID()
		now := time.Now().UTC()
		row, err := insertObject(ctx, tx, "babies", Object{"id": id, "family_id": familyID, "nickname": r.Body["name"], "birth_date": birth, "gender": dbGender(r.Body["gender"]),
			"avatar_url": r.Body["avatarUrl"], "gestational_age": age, "created_at": now, "updated_at": now})
		if err != nil {
			return nil, err
		}
		if err = verifyAvatar(ctx, tx, r.Body["avatarUrl"], familyID, id, r.Principal.UserID); err != nil {
			return nil, err
		}
		_, err = insertObject(ctx, tx, "baby_members", Object{"id": newID(), "family_id": familyID, "baby_id": id, "user_id": r.Principal.UserID, "role": "admin", "status": "active", "created_at": now, "updated_at": now})
		if err != nil {
			return nil, err
		}
		return babyDTO(row), nil
	})
	if err == nil {
		result.Status = 201
	}
	return result, err
}

func (s *Server) getBaby(ctx context.Context, r *Request) (Result, error) {
	if _, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["id"], false); err != nil {
		if normalizedError(err).Status == 403 {
			return Result{}, apiError(404, "BABY_NOT_FOUND", "Baby not found")
		}
		return Result{}, err
	}
	row, err := one(ctx, s.DB, `SELECT to_jsonb(b) FROM babies b WHERE id=$1 AND deleted_at IS NULL`, r.Params["id"])
	if err != nil {
		return Result{}, err
	}
	return ok(babyDTO(row))
}

func (s *Server) updateBaby(ctx context.Context, r *Request) (Result, error) {
	scope, err := babyManagementScope(ctx, s.DB, r.Principal.UserID, r.Params["id"])
	if err != nil {
		return Result{}, err
	}
	return s.familyMutation(ctx, r, scope.FamilyID, func(tx pgx.Tx, _ string) (any, error) {
		if _, err := babyManagementScope(ctx, tx, r.Principal.UserID, scope.BabyID); err != nil {
			return nil, err
		}
		row, err := one(ctx, tx, `SELECT to_jsonb(b) FROM babies b WHERE id=$1 AND deleted_at IS NULL`, scope.BabyID)
		if err != nil {
			return nil, err
		}
		values := Object{"version": integer(row["version"]) + 1, "updated_at": time.Now().UTC()}
		if value, ok := r.Body["name"]; ok {
			values["nickname"] = value
		}
		if value, ok := r.Body["gender"]; ok {
			values["gender"] = dbGender(value)
		}
		if value, ok := r.Body["birthDate"]; ok {
			date, err := asTime(value)
			if err != nil {
				return nil, invalid("Invalid birth date")
			}
			values["birth_date"] = date
		}
		if value, ok := r.Body["avatarUrl"]; ok {
			if value != row["avatar_url"] {
				if err = verifyAvatar(ctx, tx, value, scope.FamilyID, scope.BabyID, r.Principal.UserID); err != nil {
					return nil, err
				}
			}
			values["avatar_url"] = value
		}
		weeks, w := r.Body["gestationalWeeks"]
		days, d := r.Body["gestationalDays"]
		if w || d {
			if !w && row["gestational_age"] != nil {
				weeks = integer(row["gestational_age"]) / 7
			}
			if !d && row["gestational_age"] != nil {
				days = integer(row["gestational_age"]) % 7
			}
			values["gestational_age"] = nil
			if weeks != nil {
				values["gestational_age"] = integer(weeks)*7 + integer(days)
			}
		}
		row, err = updateColumns(ctx, tx, "babies", scope.BabyID, values)
		if err != nil {
			return nil, err
		}
		return babyDTO(row), nil
	})
}

func (s *Server) listBabyMembers(ctx context.Context, r *Request) (Result, error) {
	if _, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["id"], false); err != nil {
		return Result{}, err
	}
	rows, err := many(ctx, s.DB, `SELECT jsonb_build_object('userId',m.user_id,'babyId',m.baby_id,'familyId',m.family_id,
        'role',m.role,'displayName',u.display_name,'joinedAt',m.created_at) FROM baby_members m JOIN users u ON u.id=m.user_id
        WHERE m.baby_id=$1 AND m.status='active' AND m.deleted_at IS NULL ORDER BY m.created_at,m.id`, r.Params["id"])
	if err != nil {
		return Result{}, err
	}
	for _, row := range rows {
		row["joinedAt"] = isoValue(row["joinedAt"])
	}
	return ok(rows)
}

// An admin only counts as effective while their family membership is active
// and permits writes. Revoked/viewer members cannot prevent orphan protection.
func protectBabyAdmin(ctx context.Context, q Querier, familyID, babyID, userID string) error {
	var count int
	err := q.QueryRow(ctx, `SELECT COUNT(*) FROM baby_members bm JOIN family_members fm ON fm.user_id=bm.user_id AND fm.family_id=bm.family_id
        WHERE bm.family_id=$1 AND bm.baby_id=$2 AND bm.user_id<>$3 AND bm.role='admin' AND bm.status='active' AND bm.deleted_at IS NULL
        AND fm.status='active' AND fm.deleted_at IS NULL AND fm.role IN ('admin','member')`, familyID, babyID, userID).Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		return apiError(409, "LAST_BABY_ADMIN_PROTECTION", "Cannot remove or demote the last active baby administrator; transfer admin role first")
	}
	return nil
}

func (s *Server) addBabyMember(ctx context.Context, r *Request) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["id"], true)
	if err != nil {
		return Result{}, err
	}
	result, err := s.familyMutation(ctx, r, scope.FamilyID, func(tx pgx.Tx, _ string) (any, error) {
		current, err := babyScope(ctx, tx, r.Principal.UserID, scope.BabyID, true)
		if err != nil {
			return nil, err
		}
		if err = requireAdmin(current.BabyRole); err != nil {
			return nil, err
		}
		targetID := text(r.Body["userId"])
		role := text(r.Body["role"])
		if role == "" {
			role = "member"
		}
		if _, err = activeFamilyMember(ctx, tx, scope.FamilyID, targetID); err != nil {
			if normalizedError(err).Status == 404 {
				return nil, apiError(400, "TARGET_NOT_IN_FAMILY", "Caregiver must be an active member of this family before being assigned to baby")
			}
			return nil, err
		}
		existing, err := one(ctx, tx, `SELECT to_jsonb(m) FROM baby_members m WHERE baby_id=$1 AND user_id=$2`, scope.BabyID, targetID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if existing != nil && text(existing["status"]) == "active" && existing["deleted_at"] == nil && text(existing["role"]) == "admin" && role != "admin" {
			if err = protectBabyAdmin(ctx, tx, scope.FamilyID, scope.BabyID, targetID); err != nil {
				return nil, err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO baby_members(id,family_id,baby_id,user_id,role,status,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,'active',NOW(),NOW()) ON CONFLICT(user_id,baby_id) DO UPDATE
            SET role=EXCLUDED.role,status='active',deleted_at=NULL,version=baby_members.version+1,updated_at=NOW()`, newID(), scope.FamilyID, scope.BabyID, targetID, role)
		return Object{"success": true}, err
	})
	if err == nil {
		result.Status = 201
	}
	return result, err
}

func (s *Server) removeBabyMember(ctx context.Context, r *Request) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["id"], false)
	if err != nil {
		return Result{}, err
	}
	return s.familyMutation(ctx, r, scope.FamilyID, func(tx pgx.Tx, _ string) (any, error) {
		current, err := babyScope(ctx, tx, r.Principal.UserID, scope.BabyID, false)
		if err != nil {
			return nil, err
		}
		targetID := r.Params["userId"]
		if targetID != r.Principal.UserID {
			if err = requireAdmin(current.BabyRole); err != nil {
				return nil, err
			}
		}
		member, err := one(ctx, tx, `SELECT to_jsonb(m) FROM baby_members m WHERE baby_id=$1 AND user_id=$2 AND status='active' AND deleted_at IS NULL`, scope.BabyID, targetID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apiError(404, "MEMBER_NOT_FOUND", "Caregiver is not actively assigned to this baby")
		}
		if err != nil {
			return nil, err
		}
		// The reference domain policy requires a current effective baby admin,
		// including self-removal; a family viewer is not an effective admin.
		if current.FamilyRole == "viewer" || current.BabyRole != "admin" {
			return nil, apiError(409, "LAST_BABY_ADMIN_PROTECTION", "Baby membership revocation requires an effective administrator")
		}
		if text(member["role"]) == "admin" {
			if err = protectBabyAdmin(ctx, tx, scope.FamilyID, scope.BabyID, targetID); err != nil {
				return nil, err
			}
		}
		now := time.Now().UTC()
		_, err = updateColumns(ctx, tx, "baby_members", text(member["id"]), Object{"status": "revoked", "deleted_at": now, "updated_at": now, "version": integer(member["version"]) + 1})
		return Object{"removed": true}, err
	})
}
