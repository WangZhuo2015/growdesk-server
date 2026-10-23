package backend

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// The frozen Prisma-backed food routes expose P2039 for PostgreSQL
// raise_exception (SQLSTATE P0001). Preserve that observable error code without
// exposing SQL, constraint details, table names, or a database error message.
// This is a narrowly scoped wire adapter, not a general Prisma error emulator.
// Unrelated database errors, context cancellation, and domain errors retain
// their existing handling. The real PostgreSQL/Fastify differential covers it.
func foodLibraryErrorBoundary(handler Handler) Handler {
	return func(ctx context.Context, request *Request) (Result, error) {
		result, err := handler(ctx, request)
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "P0001" {
			return Result{}, apiError(500, "P2039", "Database operation failed")
		}
		return result, err
	}
}
