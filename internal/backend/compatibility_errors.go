package backend

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// Reference Prisma-backed routes expose P2039 for an unclassified database
// RAISE EXCEPTION (SQLSTATE P0001). Preserve that observed public error code at
// those route boundaries, without exposing SQL, parameters or driver messages.
// Domain conflicts and other database errors are not relabelled by this helper.
func legacyQueryFailure(err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "P0001" {
		return apiError(500, "P2039", "An unexpected database query error occurred")
	}
	return err
}
