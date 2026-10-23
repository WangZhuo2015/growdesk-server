package backend

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Scope checks and the data they authorize must see one database snapshot.
// A request may linearize before a concurrent revocation, but it must never
// combine that old permission with rows committed after the revocation.
func (s *Server) readSnapshot(ctx context.Context, read func(Querier) (Result, error)) (Result, error) {
	tx, err := s.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	result, err := read(tx)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}
