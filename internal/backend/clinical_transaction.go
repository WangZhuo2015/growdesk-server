package backend

import (
	"context"
	"math"

	"github.com/jackc/pgx/v5"
)

// Clinical REST commands preserve the established cursor-only behavior unless
// a handler explicitly needs the locked cursor to publish a family change.
// The callback reports whether it mutated state, so replay advances neither
// the cursor nor a related projection. Authorization is always live.
func (s *Server) clinicalTransaction(ctx context.Context, r *Request, apply func(pgx.Tx, Scope) (Result, bool, error)) (Result, error) {
	return s.clinicalTransactionWithCursor(ctx, r, func(tx pgx.Tx, scope Scope, _ int64) (Result, bool, error) {
		return apply(tx, scope)
	})
}

func (s *Server) clinicalTransactionWithCursor(ctx context.Context, r *Request, apply func(pgx.Tx, Scope, int64) (Result, bool, error)) (result Result, err error) {
	defer func() { err = legacyQueryFailure(err) }()
	scope, err := medicalScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, scope.FamilyID)
	if err != nil {
		return Result{}, err
	}
	current, err := medicalScope(ctx, tx, r.Principal.UserID, scope.BabyID, true)
	if err != nil {
		return Result{}, err
	}
	if current.FamilyID != scope.FamilyID {
		return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Baby scope changed")
	}
	result, changed, err := apply(tx, current, cursor)
	if err != nil {
		return Result{}, err
	}
	if changed {
		if cursor == math.MaxInt64 {
			return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted")
		}
		if _, err = tx.Exec(ctx, "UPDATE family_sync_states SET cursor=$2,updated_at=NOW() WHERE family_id=$1", current.FamilyID, cursor+1); err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}
