package backend

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type APIError struct{Status int;Code,Message string;Details any}
func(e *APIError)Error()string{return e.Code+": "+e.Message}
func apiError(status int,code,message string)error{return &APIError{Status:status,Code:code,Message:message}}
func invalid(message string)error{return apiError(400,"BAD_REQUEST",message)}
func notFound(entity,id string)error{return apiError(404,"RECORD_NOT_FOUND",entity+" with ID "+id+" not found")}
func normalizedError(err error)*APIError{
	var app *APIError;if errors.As(err,&app){return app}
	if errors.Is(err,pgx.ErrNoRows){return &APIError{Status:404,Code:"NOT_FOUND",Message:"Resource not found"}}
	if errors.Is(err,context.DeadlineExceeded)||errors.Is(err,context.Canceled){return &APIError{Status:503,Code:"DEPENDENCY_UNAVAILABLE",Message:"Request could not be completed"}}
	var pg *pgconn.PgError;if errors.As(err,&pg){switch pg.Code{case "23505":return &APIError{Status:409,Code:"CONFLICT",Message:"Resource already exists"};case "23503","23514","22003","22P02":return &APIError{Status:400,Code:"BAD_REQUEST",Message:"Invalid resource data"};case "40001","40P01":return &APIError{Status:409,Code:"CONCURRENT_MODIFICATION",Message:"Concurrent transaction; retry with the same idempotency key"};case "53300","57P01","57P02","57P03":return &APIError{Status:503,Code:"DEPENDENCY_UNAVAILABLE",Message:"Database unavailable"}}}
	return &APIError{Status:http.StatusInternalServerError,Code:"INTERNAL_ERROR",Message:"An unexpected error occurred"}
}
