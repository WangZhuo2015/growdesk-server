package backend

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Scope is always loaded from current database rows, never from a requested
// user/family header or a login-time snapshot of the caller's memberships.
type Scope struct {
	FamilyID   string
	BabyID     string
	FamilyRole string
	BabyRole   string
}

func familyRole(ctx context.Context, q Querier, userID, familyID string) (string, error) {
	var role string
	err := q.QueryRow(ctx, `SELECT fm.role FROM family_members fm
        JOIN families f ON f.id=fm.family_id AND f.deleted_at IS NULL
        JOIN users u ON u.id=fm.user_id AND u.deleted_at IS NULL
        WHERE fm.family_id=$1 AND fm.user_id=$2 AND fm.status='active' AND fm.deleted_at IS NULL`, familyID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+familyID)
	}
	if err != nil {
		return "", err
	}
	if role != "admin" && role != "member" && role != "viewer" {
		return "", apiError(500, "INVALID_FAMILY_MEMBER_ROLE", "Unsupported family member role")
	}
	return role, nil
}

func babyScope(ctx context.Context, q Querier, userID, babyID string, write bool) (Scope, error) {
	scope := Scope{BabyID: babyID}
	err := q.QueryRow(ctx, `SELECT family_id FROM babies WHERE id=$1 AND deleted_at IS NULL`, babyID).Scan(&scope.FamilyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return scope, apiError(403, "BABY_NOT_FOUND", "Access denied to baby: "+babyID+" (BABY_NOT_FOUND)")
	}
	if err != nil {
		return scope, err
	}
	scope.FamilyRole, err = familyRole(ctx, q, userID, scope.FamilyID)
	if err != nil {
		return scope, err
	}
	if write && scope.FamilyRole == "viewer" {
		return scope, apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+scope.FamilyID)
	}
	err = q.QueryRow(ctx, `SELECT role FROM baby_members WHERE baby_id=$1 AND family_id=$2 AND user_id=$3 AND status='active' AND deleted_at IS NULL`, babyID, scope.FamilyID, userID).Scan(&scope.BabyRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return scope, apiError(403, "BABY_ACCESS_DENIED", "Access denied to baby: "+babyID+" (BABY_ACCESS_DENIED)")
	}
	if err != nil {
		return scope, err
	}
	if write && scope.BabyRole == "viewer" {
		return scope, apiError(403, "BABY_WRITE_DENIED", "Access denied to baby: "+babyID+" (BABY_WRITE_DENIED)")
	}
	if scope.BabyRole != "admin" && scope.BabyRole != "member" && scope.BabyRole != "viewer" {
		return scope, apiError(403, "BABY_ACCESS_DENIED", "Unsupported baby member role")
	}
	return scope, nil
}

// All family mutations (including revocations) serialize on this row. Recheck
// authorization after acquiring the lock, including every idempotent replay.
func lockFamily(ctx context.Context, tx pgx.Tx, familyID string) (int64, error) {
	_, err := tx.Exec(ctx, `INSERT INTO family_sync_states(family_id,epoch,cursor,permission_version,created_at,updated_at)
        VALUES($1,$2,0,1,NOW(),NOW()) ON CONFLICT(family_id) DO NOTHING`, familyID, newID())
	if err != nil {
		return 0, err
	}
	var cursor int64
	err = tx.QueryRow(ctx, `SELECT cursor FROM family_sync_states WHERE family_id=$1 FOR UPDATE`, familyID).Scan(&cursor)
	return cursor, err
}

func bumpPermission(ctx context.Context, tx pgx.Tx, familyID string) error {
	_, err := tx.Exec(ctx, `UPDATE family_sync_states SET permission_version=permission_version+1,updated_at=NOW() WHERE family_id=$1`, familyID)
	return err
}

func (s *Server) familyMutation(ctx context.Context, r *Request, familyID string, fn func(pgx.Tx, string) (any, error)) (Result, error) {
	if _, err := familyRole(ctx, s.DB, r.Principal.UserID, familyID); err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if _, err = lockFamily(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	role, err := familyRole(ctx, tx, r.Principal.UserID, familyID)
	if err != nil {
		return Result{}, err
	}
	value, err := fn(tx, role)
	if err != nil {
		return Result{}, err
	}
	if err = bumpPermission(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(value)
}

func requireAdmin(role string) error {
	if role != "admin" {
		return apiError(403, "FORBIDDEN", "Only administrators can perform this operation")
	}
	return nil
}

// columns must be from a compile-time allowlist. Values stay bound parameters.
func updateColumns(ctx context.Context, q Querier, table, id string, values Object) (Object, error) {
	if len(values) == 0 {
		return one(ctx, q, "SELECT to_jsonb(t) FROM "+pgx.Identifier{table}.Sanitize()+" t WHERE id=$1", id)
	}
	keys := sortedKeys(values)
	args := []any{id}
	sets := make([]string, 0, len(keys))
	for _, key := range keys {
		args = append(args, values[key])
		sets = append(sets, fmt.Sprintf("%s=$%d", pgx.Identifier{key}.Sanitize(), len(args)))
	}
	return one(ctx, q, "UPDATE "+pgx.Identifier{table}.Sanitize()+" t SET "+joinComma(sets)+" WHERE id=$1 RETURNING to_jsonb(t)", args...)
}

func (s *Server) registerManagement(id string, public bool, h Handler) {
	s.Register(id, public, func(ctx context.Context, r *Request) (Result, error) {
		result, err := h(ctx, r)
		if err == nil {
			return result, nil
		}
		e := normalizedError(err)
		if e.Code != "FAMILY_ACCESS_DENIED" && e.Code != "BABY_ACCESS_DENIED" && e.Code != "BABY_NOT_FOUND" && e.Code != "BABY_WRITE_DENIED" {
			return result, err
		}
		switch id {
		case "getFamily", "updateFamily", "createFamilyInvite":
			return Result{}, apiError(404, "FAMILY_NOT_FOUND", "Family not found or access denied")
		case "getBaby", "updateBaby", "listBabyMembers":
			return Result{}, apiError(404, "BABY_NOT_FOUND", "Baby not found")
		case "addBabyMember", "removeBabyMember":
			if e.Code == "BABY_NOT_FOUND" {
				return Result{}, apiError(404, "BABY_NOT_FOUND", "Baby not found")
			}
		}
		return Result{}, apiError(403, "FORBIDDEN", "Access denied")
	})
}

func babyManagementScope(ctx context.Context, q Querier, userID, babyID string) (Scope, error) {
	scope, err := babyScope(ctx, q, userID, babyID, false)
	if err != nil {
		return scope, err
	}
	if scope.FamilyRole == "viewer" {
		return scope, apiError(403, "FORBIDDEN", "Family viewers cannot modify baby details")
	}
	if scope.BabyRole == "viewer" {
		return scope, apiError(403, "FORBIDDEN", "Baby viewers cannot modify baby details")
	}
	return scope, nil
}

func sortedKeys(values Object) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
func joinComma(values []string) string { return strings.Join(values, ",") }
