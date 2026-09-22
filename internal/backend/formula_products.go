package backend

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Server) registerFormulaProducts() {
	const collection = "/api/v1/families/{familyId}/nutrition/products"
	s.registerDeclared(http.MethodGet, collection, s.listFormulaProducts)
	s.registerDeclared(http.MethodPost, collection, func(ctx context.Context, r *Request) (Result, error) {
		return s.mutateFormulaProduct(ctx, r, "create")
	})
	s.registerDeclared(http.MethodPatch, collection+"/{id}", func(ctx context.Context, r *Request) (Result, error) {
		return s.mutateFormulaProduct(ctx, r, "update")
	})
	s.registerDeclared(http.MethodDelete, collection+"/{id}", func(ctx context.Context, r *Request) (Result, error) {
		return s.mutateFormulaProduct(ctx, r, "delete")
	})
}

func formulaProductDTO(row Object) Object {
	return Object{
		"id": row["id"], "familyId": row["family_id"], "brand": row["brand"], "name": row["name"],
		"stage": row["stage"], "scoopGrams": decimalValue(row["scoop_weight_g"]),
		"waterMlPerScoop":     decimalValue(row["water_per_scoop_ml"]),
		"reconstitutionRatio": decimalValue(row["reconstitution_ratio"]),
		"servingSizeUnit":     row["serving_size_unit"], "nutrientsJson": row["nutrients_json"], "notes": row["notes"],
		"isActive": row["is_active"], "isDefault": row["is_default"], "isArchived": row["is_archived"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"]),
	}
}

func formulaProductValues(body Object, create bool) (Object, error) {
	values := Object{}
	// These fields are intentionally identical to FormulaProductService's
	// allowlist. Metadata/notes/default-selection writes are not invented here.
	for _, field := range []struct{ wire, column string }{
		{"brand", "brand"}, {"name", "name"}, {"stage", "stage"},
		{"scoopGrams", "scoop_weight_g"}, {"waterMlPerScoop", "water_per_scoop_ml"},
	} {
		value, present := body[field.wire]
		if !present && !create {
			continue
		}
		if value != nil && (field.wire == "scoopGrams" || field.wire == "waterMlPerScoop") {
			var decimal pgtype.Numeric
			if err := decimal.Scan(text(value)); err != nil {
				return nil, invalid("Invalid decimal " + field.wire)
			}
			value = decimal
		}
		values[field.column] = value
	}
	if value, present := body["isArchived"]; present && !create {
		values["is_archived"] = value
	}
	return values, nil
}

func (s *Server) listFormulaProducts(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		familyID := r.Params["familyId"]
		args := []any{familyID}
		where := "family_id=$1 AND deleted_at IS NULL"
		if r.HTTP.URL.Query().Get("includeArchived") != "true" {
			where += " AND NOT is_archived"
		}
		if raw := r.HTTP.URL.Query().Get("cursor"); raw != "" {
			clock, id, err := companionCursor(raw, "INVALID_CURSOR")
			if err != nil {
				return Result{}, err
			}
			args = append(args, clock, id)
			where += " AND (created_at,id)<($2,$3)"
		}
		if _, err := familyRole(ctx, q, r.Principal.UserID, familyID); err != nil {
			return Result{}, err
		}
		limit := companionLimit(r, 50, 200)
		args = append(args, limit+1)
		rows, err := many(ctx, q, "SELECT to_jsonb(p) FROM formula_products p WHERE "+where+
			" ORDER BY created_at DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
		if err != nil {
			return Result{}, err
		}
		var next any
		if len(rows) > limit {
			rows = rows[:limit]
			last := rows[len(rows)-1]
			next = encodeCareCursor(last["created_at"], last["id"])
		}
		data := make([]Object, 0, len(rows))
		for _, row := range rows {
			data = append(data, formulaProductDTO(row))
		}
		return Result{Status: http.StatusOK, Body: page(data, next)}, nil
	})
}

func (s *Server) mutateFormulaProduct(ctx context.Context, r *Request, operation string) (Result, error) {
	familyID := r.Params["familyId"]
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	// Hold live membership until commit. Catalog mutations do not advance a
	// family care cursor or generate a care idempotency receipt in the reference.
	var role string
	err = tx.QueryRow(ctx, `SELECT fm.role FROM family_members fm
		JOIN families f ON f.id=fm.family_id AND f.deleted_at IS NULL
		WHERE fm.family_id=$1 AND fm.user_id=$2 AND fm.status='active' AND fm.deleted_at IS NULL
		FOR SHARE OF fm,f`, familyID, r.Principal.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && role != "admin" && role != "member") {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+familyID)
	}
	if err != nil {
		return Result{}, err
	}
	id := r.Params["id"]
	if operation != "create" {
		_, err = one(ctx, tx, `SELECT to_jsonb(p) FROM formula_products p
			WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR UPDATE`, id, familyID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, notFound("formula_product", id)
		}
		if err != nil {
			return Result{}, err
		}
	}
	values, err := formulaProductValues(r.Body, operation == "create")
	if err != nil {
		return Result{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	values["updated_at"] = now
	var row Object
	switch operation {
	case "create":
		values["id"], values["family_id"], values["created_at"] = newID(), familyID, now
		row, err = insertObject(ctx, tx, "formula_products", values)
	case "delete":
		row, err = updateColumns(ctx, tx, "formula_products", id, Object{
			"deleted_at": now, "updated_at": now, "is_archived": true,
		})
	default:
		row, err = updateColumns(ctx, tx, "formula_products", id, values)
	}
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	if operation == "delete" {
		return ok(Object{"id": id, "deleted": true})
	}
	if operation == "create" {
		return created(formulaProductDTO(row))
	}
	return ok(formulaProductDTO(row))
}
