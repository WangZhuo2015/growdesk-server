package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Server) registerSupplementCatalog() {
	s.Register("listSupplementProducts", false, s.listSupplementProducts)
	for _, op := range []string{"create", "update", "delete"} {
		operation := op
		s.Register(op+"SupplementProduct", false, func(ctx context.Context, r *Request) (Result, error) {
			return s.mutateSupplementProduct(ctx, r, operation)
		})
	}
	s.Register("listSupplementSchedules", false, s.listSupplementSchedules)
	s.Register("upsertSupplementSchedule", false, s.upsertSupplementSchedule)
	s.Register("deleteSupplementSchedule", false, s.deleteSupplementSchedule)
}

func supplementProductDTO(row Object) Object {
	return Object{
		"id": row["id"], "familyId": row["family_id"], "name": row["name"], "brand": row["brand"],
		"dosageForm": row["dosage_form"], "unitName": row["unit_name"], "defaultDose": decimalValue(row["default_dose"]),
		"nutrientsJson": row["nutrients_json"], "notes": row["notes"], "isArchived": row["is_archived"],
		"isActive": boolean(row["is_active"]) && !boolean(row["is_archived"]), "version": row["version"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"]),
	}
}

func supplementScheduleDTO(row, product Object, completed bool) Object {
	return Object{
		"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "productId": row["product_id"],
		"product": supplementProductDTO(product), "frequency": row["frequency"], "customDays": row["custom_days_json"],
		"targetDose": decimalValue(row["target_dose"]), "reminderTime": row["reminder_time"], "isActive": row["is_active"],
		"startDate": dateValue(row["start_date"]), "notes": row["notes"], "version": row["version"],
		"isCompletedToday": completed, "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"]),
	}
}

var supplementCursorID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func supplementProductCursor(raw string) (time.Time, string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
	parts := strings.SplitN(string(decoded), "|", 2)
	if err == nil && len(parts) == 2 && supplementCursorID.MatchString(parts[1]) {
		if clock, parseErr := asTime(parts[0]); parseErr == nil {
			return clock, parts[1], nil
		}
	}
	return time.Time{}, "", apiError(400, "INVALID_CURSOR", "Invalid supplement product cursor")
}

func (s *Server) listSupplementProducts(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		fid := r.Params["familyId"]
		if _, err := familyRole(ctx, q, r.Principal.UserID, fid); err != nil {
			return Result{}, err
		}
		args := []any{fid}
		where := "family_id=$1 AND deleted_at IS NULL"
		if r.HTTP.URL.Query().Get("includeArchived") != "true" {
			where += " AND NOT is_archived AND is_active"
		}
		if raw := r.HTTP.URL.Query().Get("cursor"); raw != "" {
			clock, id, err := supplementProductCursor(raw)
			if err != nil { return Result{}, err }
			args = append(args, clock, id)
			where += " AND (created_at,id)<($2,$3)"
		}
		limit := pageLimit(r)
		args = append(args, limit+1)
		rows, err := many(ctx, q, "SELECT to_jsonb(p) FROM supplement_products p WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
		if err != nil { return Result{}, err }
		var next any
		if len(rows) > limit {
			rows = rows[:limit]
			last := rows[len(rows)-1]
			next = encodeCareCursor(last["created_at"], last["id"])
		}
		data := make([]Object, 0, len(rows))
		for _, row := range rows { data = append(data, supplementProductDTO(row)) }
		return Result{Status: 200, Body: page(data, next)}, nil
	})
}

// Catalog REST writes in the frozen service advance only the family cursor.
// Do not invent care receipts, timeline entries or change events. Re-read live
// permissions after locking, including optional baby scope for schedules.
func (s *Server) supplementTransaction(ctx context.Context, r *Request, fid, bid string, apply func(pgx.Tx) (Result, error)) (result Result, err error) {
	defer func() { err = legacyQueryFailure(err) }()
	check := func(q Querier) error {
		role, e := familyRole(ctx, q, r.Principal.UserID, fid)
		if e != nil { return e }
		if role == "viewer" { return apiError(403, "FAMILY_ACCESS_DENIED", "Family write access denied") }
		if bid != "" {
			scope, e := babyScope(ctx, q, r.Principal.UserID, bid, true)
			if e != nil { return e }
			if scope.FamilyID != fid { return apiError(403, "BABY_SCOPE_MISMATCH", "Baby scope changed") }
		}
		return nil
	}
	if err = check(s.DB); err != nil { return Result{}, err }
	tx, err := s.DB.Begin(ctx)
	if err != nil { return Result{}, err }
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, fid)
	if err != nil { return Result{}, err }
	if err = check(tx); err != nil { return Result{}, err }
	if cursor == math.MaxInt64 { return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted") }
	result, err = apply(tx)
	if err != nil { return Result{}, err }
	if _, err = tx.Exec(ctx, "UPDATE family_sync_states SET cursor=$2,updated_at=NOW() WHERE family_id=$1", fid, cursor+1); err != nil { return Result{}, err }
	if err = tx.Commit(ctx); err != nil { return Result{}, err }
	return result, nil
}

func nullableJSONValue(value any) (json.RawMessage, error) {
	raw, err := jsonBytes(value)
	return json.RawMessage(raw), err
}

func catalogDecimal(value any) (pgtype.Numeric, error) {
	var number pgtype.Numeric
	if err := number.Scan(text(value)); err != nil { return number, invalid("Invalid decimal") }
	return number, nil
}

func nextCatalogVersion(row Object, body Object) (int64, error) {
	version := integer(row["version"])
	if supplied, exists := body["baseVersion"]; exists && integer(supplied) != version {
		return 0, apiError(409, "CONCURRENCY_CONFLICT", "Catalog changed; reload before saving")
	}
	if version < 1 || version >= math.MaxInt32 { return 0, apiError(409, "CONCURRENCY_CONFLICT", "Catalog version range exhausted") }
	return version + 1, nil
}

func (s *Server) mutateSupplementProduct(ctx context.Context, r *Request, operation string) (Result, error) {
	fid, id := r.Params["familyId"], r.Params["id"]
	return s.supplementTransaction(ctx, r, fid, "", func(tx pgx.Tx) (Result, error) {
		version := int64(1)
		if operation != "create" {
			row, err := one(ctx, tx, "SELECT to_jsonb(p) FROM supplement_products p WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR UPDATE", id, fid)
			if errors.Is(err, pgx.ErrNoRows) { return Result{}, notFound("supplement_product", id) }
			if err != nil { return Result{}, err }
			version, err = nextCatalogVersion(row, r.Body)
			if err != nil { return Result{}, err }
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		if operation == "delete" {
			if _, err := tx.Exec(ctx, "UPDATE supplement_products SET deleted_at=$3,updated_at=$3,is_archived=true,is_active=false,version=$4 WHERE id=$1 AND family_id=$2", id, fid, now, version); err != nil { return Result{}, err }
			if _, err := tx.Exec(ctx, "UPDATE supplement_schedules SET deleted_at=$3,updated_at=$3,is_active=false,version=version+1 WHERE product_id=$1 AND family_id=$2 AND deleted_at IS NULL", id, fid, now); err != nil { return Result{}, err }
			return ok(Object{"id": id, "deleted": true})
		}
		values := Object{"version": version, "updated_at": now}
		for _, field := range []struct{ wire, column string }{
			{"name", "name"}, {"brand", "brand"}, {"dosageForm", "dosage_form"}, {"unitName", "unit_name"},
			{"defaultDose", "default_dose"}, {"nutrientsJson", "nutrients_json"}, {"notes", "notes"},
			{"isActive", "is_active"}, {"isArchived", "is_archived"},
		} {
			value, exists := r.Body[field.wire]
			if !exists {
				if operation != "create" { continue }
				switch field.wire {
				case "defaultDose": value = "1"
				case "isActive": value = true
				case "isArchived": value = false
				}
			}
			var err error
			switch field.wire {
			case "name", "unitName": value = strings.TrimSpace(text(value))
			case "defaultDose": value, err = catalogDecimal(value)
			case "nutrientsJson": value, err = nullableJSONValue(value)
			}
			if err != nil { return Result{}, err }
			values[field.column] = value
		}
		var row Object
		var err error
		if operation == "create" {
			values["id"], values["family_id"], values["created_at"] = newID(), fid, now
			row, err = insertObject(ctx, tx, "supplement_products", values)
		} else { row, err = updateColumns(ctx, tx, "supplement_products", id, values) }
		if err != nil { return Result{}, err }
		if operation == "create" { return created(supplementProductDTO(row)) }
		return ok(supplementProductDTO(row))
	})
}

func (s *Server) listSupplementSchedules(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		// Preserve the reference window: explicit date is UTC midnight; absent
		// date starts at the current instant rather than silently changing UX.
		day := time.Now().UTC().Truncate(time.Millisecond)
		if raw := r.HTTP.URL.Query().Get("date"); raw != "" {
			day, err = time.Parse("2006-01-02", raw)
			if err != nil { return Result{}, invalid("Invalid schedule date") }
		}
		rows, err := many(ctx, q, `SELECT jsonb_build_object('schedule',to_jsonb(s),'product',to_jsonb(p),
			'completed',EXISTS(SELECT 1 FROM supplement_records r WHERE r.family_id=s.family_id AND r.baby_id=s.baby_id
			AND r.product_id=s.product_id AND r.deleted_at IS NULL AND r.occurred_at >= $3 AND r.occurred_at < $4))
			FROM supplement_schedules s JOIN supplement_products p ON p.id=s.product_id AND p.family_id=s.family_id
			WHERE s.family_id=$1 AND s.baby_id=$2 AND s.deleted_at IS NULL AND s.is_active
			ORDER BY s.created_at DESC,s.id DESC`, scope.FamilyID, scope.BabyID, day, day.Add(24*time.Hour))
		if err != nil { return Result{}, err }
		data := make([]Object, 0, len(rows))
		for _, row := range rows { data = append(data, supplementScheduleDTO(obj(row["schedule"]), obj(row["product"]), boolean(row["completed"]))) }
		return Result{Status: 200, Body: page(data, nil)}, nil
	})
}

func (s *Server) upsertSupplementSchedule(ctx context.Context, r *Request) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil { return Result{}, err }
	return s.supplementTransaction(ctx, r, scope.FamilyID, scope.BabyID, func(tx pgx.Tx) (Result, error) {
		productID, id := text(r.Body["productId"]), text(r.Body["id"])
		product, err := one(ctx, tx, "SELECT to_jsonb(p) FROM supplement_products p WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR UPDATE", productID, scope.FamilyID)
		if errors.Is(err, pgx.ErrNoRows) { return Result{}, notFound("supplement_product", productID) }
		if err != nil { return Result{}, err }
		var previous Object
		if id != "" {
			previous, err = one(ctx, tx, "SELECT to_jsonb(s) FROM supplement_schedules s WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL FOR UPDATE", id, scope.FamilyID, scope.BabyID)
		} else {
			previous, err = one(ctx, tx, "SELECT to_jsonb(s) FROM supplement_schedules s WHERE family_id=$1 AND baby_id=$2 AND product_id=$3 AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE", scope.FamilyID, scope.BabyID, productID)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			if id != "" { return Result{}, notFound("supplement_schedule", id) }
			previous, err = nil, nil
		}
		if err != nil { return Result{}, err }
		version := int64(1)
		if previous != nil {
			id = text(previous["id"])
			version, err = nextCatalogVersion(previous, r.Body)
			if err != nil { return Result{}, err }
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		values := Object{"family_id": scope.FamilyID, "baby_id": scope.BabyID, "product_id": productID, "version": version, "deleted_at": nil, "updated_at": now}
		for _, field := range []struct{ wire, column string; initial any }{
			{"frequency", "frequency", "daily"}, {"customDays", "custom_days_json", nil}, {"targetDose", "target_dose", "1"},
			{"reminderTime", "reminder_time", nil}, {"isActive", "is_active", true}, {"startDate", "start_date", nil}, {"notes", "notes", nil},
		} {
			value, exists := r.Body[field.wire]
			if !exists {
				value = field.initial
				if previous != nil { value = previous[field.column] }
			}
			switch field.wire {
			case "customDays": value, err = nullableJSONValue(value)
			case "targetDose": value, err = catalogDecimal(value)
			case "startDate":
				if value != nil { value, err = time.Parse("2006-01-02", text(dateValue(value))) }
			}
			if err != nil { return Result{}, invalid("Invalid schedule field "+field.wire) }
			values[field.column] = value
		}
		var row Object
		if previous == nil {
			values["id"], values["created_at"] = newID(), now
			row, err = insertObject(ctx, tx, "supplement_schedules", values)
		} else { row, err = updateColumns(ctx, tx, "supplement_schedules", id, values) }
		if err != nil { return Result{}, err }
		if previous == nil { return created(supplementScheduleDTO(row, product, false)) }
		return ok(supplementScheduleDTO(row, product, false))
	})
}

func (s *Server) deleteSupplementSchedule(ctx context.Context, r *Request) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil { return Result{}, err }
	return s.supplementTransaction(ctx, r, scope.FamilyID, scope.BabyID, func(tx pgx.Tx) (Result, error) {
		id := r.Params["id"]
		row, err := one(ctx, tx, "SELECT to_jsonb(s) FROM supplement_schedules s WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL FOR UPDATE", id, scope.FamilyID, scope.BabyID)
		if errors.Is(err, pgx.ErrNoRows) { return Result{}, notFound("supplement_schedule", id) }
		if err != nil { return Result{}, err }
		version, err := nextCatalogVersion(row, nil)
		if err != nil { return Result{}, err }
		if _, err = tx.Exec(ctx, "UPDATE supplement_schedules SET deleted_at=NOW(),updated_at=NOW(),is_active=false,version=$4 WHERE id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID, version); err != nil { return Result{}, err }
		return ok(Object{"id": id, "deleted": true})
	})
}
