package backend

import (
	"context"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerFoodPlans() {
	s.Register("getFoodPlan", false, s.getFoodPlan)
	s.Register("saveFoodPlan", false, s.saveFoodPlan)
}

func foodPlanVersion(raw string) (int64, error) {
	if raw == "" {
		return 0, apiError(400, "INVALID_BASE_VERSION", "baseVersion must be a non-negative 64-bit integer")
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, apiError(400, "INVALID_BASE_VERSION", "baseVersion must be a non-negative 64-bit integer")
		}
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, apiError(400, "INVALID_BASE_VERSION", "baseVersion must be a non-negative 64-bit integer")
	}
	return n, nil
}

func foodPlanDTO(row Object) Object {
	return Object{
		"id": row["id"], "babyId": row["baby_id"], "planData": row["plan_data"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"]),
		"version": text(row["version"]),
	}
}

func (s *Server) getFoodPlan(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		row, err := one(ctx, q, `SELECT to_jsonb(p) FROM baby_food_plans p WHERE family_id=$1 AND baby_id=$2`, scope.FamilyID, scope.BabyID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ok(Object{"id": nil, "babyId": scope.BabyID, "planData": Object{}, "createdAt": nil, "updatedAt": iso(time.Now()), "version": "0"})
		}
		if err != nil {
			return Result{}, err
		}
		return ok(foodPlanDTO(row))
	})
}

// A food plan is one shared JSON document. Do not merge a stale document or
// automatically retry its write: the caller must reconcile a 409 explicitly.
func (s *Server) saveFoodPlan(ctx context.Context, r *Request) (Result, error) {
	version, err := foodPlanVersion(text(r.Body["baseVersion"]))
	if err != nil {
		return Result{}, err
	}
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil {
		return Result{}, err
	}
	raw, err := jsonText(r.Body["planData"])
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	// The same lock order as member/record mutations closes the authorization
	// race. Taking the lock does not advance the care sync cursor.
	if _, err = lockFamily(ctx, tx, scope.FamilyID); err != nil {
		return Result{}, err
	}
	current, err := babyScope(ctx, tx, r.Principal.UserID, scope.BabyID, true)
	if err != nil {
		return Result{}, err
	}
	if current.FamilyID != scope.FamilyID {
		return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Baby scope changed")
	}
	if version == math.MaxInt64 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food plan version range exhausted")
	}
	var row Object
	if version == 0 {
		row, err = one(ctx, tx, `INSERT INTO baby_food_plans AS p (id,family_id,baby_id,plan_data,version,created_at,updated_at)
			VALUES($1,$2,$3,$4::jsonb,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
			ON CONFLICT(baby_id) DO NOTHING RETURNING to_jsonb(p)`, newID(), scope.FamilyID, scope.BabyID, raw)
	} else {
		row, err = one(ctx, tx, `UPDATE baby_food_plans p SET plan_data=$4::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP
			WHERE family_id=$1 AND baby_id=$2 AND version=$3 RETURNING to_jsonb(p)`, scope.FamilyID, scope.BabyID, version, raw)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food plan changed; reload before saving")
	}
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(foodPlanDTO(row))
}
