package backend

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestFoodLibraryRaisedDatabaseError(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		var source error = &pgconn.PgError{Code: "P0001", Message: "test_private_sql_detail", Detail: "test_private_constraint", TableName: "test_private_table"}
		if wrapped {
			source = fmt.Errorf("test wrapped: %w", source)
		}
		h := foodLibraryErrorBoundary(func(context.Context, *Request) (Result, error) {
			return Result{Status: 201, Body: Object{"id": "test_uncommitted"}}, source
		})
		result, err := h(context.Background(), &Request{})
		if err == nil || result.Body != nil {
			t.Fatal("a failed database operation must not expose a success result")
		}
		e := normalizedError(err)
		if e.Status != 500 || e.Code != "P2039" {
			t.Fatalf("reference error status/code changed: %+v", e)
		}
		for _, secret := range []string{"test_private_sql_detail", "test_private_constraint", "test_private_table"} {
			if strings.Contains(e.Message, secret) {
				t.Fatal("database internals leaked")
			}
		}
	}
}

func TestFoodLibraryErrorBoundaryPreservesOtherOutcomes(t *testing.T) {
	for _, source := range []error{
		nil, context.Canceled, context.DeadlineExceeded,
		apiError(403, "FAMILY_ACCESS_DENIED", "test family access denied"),
		&pgconn.PgError{Code: "23505", Message: "test unique constraint"},
		errors.New("P0001 in an unrelated error message"),
	} {
		want := Result{Status: 200, Body: Object{"data": []string{}}}
		h := foodLibraryErrorBoundary(func(context.Context, *Request) (Result, error) { return want, source })
		got, err := h(context.Background(), &Request{})
		if !reflect.DeepEqual(got, want) || err != source {
			t.Fatalf("unrelated result/error was rewritten: %+v, %v", got, err)
		}
	}
}
