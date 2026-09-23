package backend

import (
	"context"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerMedicalReports() {
	s.Register("listMedicalReports", false, s.listMedicalReports)
	s.Register("getMedicalReport", false, s.getMedicalReport)
	for _, operation := range []string{"create", "update", "delete"} {
		op := operation
		s.Register(op+"MedicalReport", false, func(ctx context.Context, r *Request) (Result, error) {
			return s.mutateMedicalReport(ctx, r, op)
		})
	}
}

// Medical APIs historically use one baby-access error for denied family or
// caregiver access. Keep that wire code while using current database grants.
func medicalScope(ctx context.Context, q Querier, user, baby string, write bool) (Scope, error) {
	scope, err := babyScope(ctx, q, user, baby, write)
	if err != nil && normalizedError(err).Status == 403 {
		return Scope{}, apiError(403, "BABY_ACCESS_DENIED", "Medical record access denied")
	}
	return scope, err
}

const medicalProjection = `to_jsonb(r) || jsonb_build_object('attachment_ids',
	COALESCE((SELECT jsonb_agg(a.attachment_id) FROM medical_report_attachments a WHERE a.report_id=r.id),'[]'::jsonb))`

func medicalReportDTO(row Object) Object {
	items := row["items"]
	if _, ok := items.([]any); !ok { items = []any{} }
	attachments := row["attachment_ids"]
	if attachments == nil { attachments = []any{} }
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"],
		"reportDate": dateValue(row["report_date"]), "title": row["title"], "hospital": row["hospital"],
		"department": row["department"], "diagnosis": row["diagnosis"], "notes": row["notes"],
		"items": items, "attachmentIds": attachments, "version": text(row["version"]),
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func readMedicalReport(ctx context.Context, q Querier, scope Scope, id string) (Object, error) {
	row, err := one(ctx, q, "SELECT "+medicalProjection+" FROM medical_reports r WHERE r.id=$1 AND r.family_id=$2 AND r.baby_id=$3 AND r.deleted_at IS NULL", id, scope.FamilyID, scope.BabyID)
	if errors.Is(err, pgx.ErrNoRows) { return nil, notFound("MedicalReport", id) }
	return row, err
}

func (s *Server) listMedicalReports(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		limit := pageLimit(r)
		if r.HTTP.URL.Query().Get("limit") == "" { limit = 20 }
		if limit > 100 { limit = 100 }
		args := []any{scope.FamilyID, scope.BabyID}
		where := "r.family_id=$1 AND r.baby_id=$2 AND r.deleted_at IS NULL"
		if clock, id, valid := decodeNutritionCursor(careSpec{Kind: "food"}, r.HTTP.URL.Query().Get("cursor")); valid {
			if day, err := time.Parse("2006-01-02", text(clock)); err == nil {
				args = append(args, day, id)
				where += " AND (r.report_date,r.id)<($3,$4)"
			}
		}
		args = append(args, limit+1)
		rows, err := many(ctx, q, "SELECT "+medicalProjection+" FROM medical_reports r WHERE "+where+" ORDER BY r.report_date DESC,r.id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
		if err != nil { return Result{}, err }
		var next any
		if len(rows) > limit {
			rows = rows[:limit]; last := rows[len(rows)-1]
			next = encodeNutritionCursor(careSpec{Kind: "food"}, dateValue(last["report_date"]), last["id"])
		}
		data := make([]Object, 0, len(rows))
		for _, row := range rows { data = append(data, medicalReportDTO(row)) }
		return Result{Status: 200, Body: page(data, next)}, nil
	})
}

func (s *Server) getMedicalReport(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		row, err := readMedicalReport(ctx, q, scope, r.Params["id"])
		if err != nil { return Result{}, err }
		return ok(medicalReportDTO(row))
	})
}

func (s *Server) mutateMedicalReport(ctx context.Context, r *Request, operation string) (result Result, err error) {
	defer func() { err = legacyQueryFailure(err) }()
	scope, err := medicalScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil { return Result{}, err }
	baseVersion := int64(0)
	if operation != "create" {
		raw := text(r.Body["baseVersion"])
		if operation == "delete" { raw = r.HTTP.URL.Query().Get("baseVersion") }
		baseVersion, err = parseWireVersion(raw)
		if err != nil { return Result{}, err }
	}
	key, requestHash := r.HTTP.Header.Get("Idempotency-Key"), ""
	if operation == "create" && key != "" {
		requestHash, err = documentBodyHash(r)
		if err != nil { return Result{}, err }
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil { return Result{}, err }
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, scope.FamilyID)
	if err != nil { return Result{}, err }
	current, err := medicalScope(ctx, tx, r.Principal.UserID, scope.BabyID, true)
	if err != nil { return Result{}, err }
	if current.FamilyID != scope.FamilyID { return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Baby scope changed") }
	if cursor == math.MaxInt64 { return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted") }
	id := r.Params["id"]
	if operation == "create" {
		id = newID()
		if key != "" {
			receipt, queryErr := one(ctx, tx, "SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3", r.Principal.UserID, scope.FamilyID, key)
			if queryErr == nil {
				if text(receipt["request_hash"]) != requestHash { return Result{}, reusedKey(key) }
				replayed, readErr := readMedicalReport(ctx, tx, scope, text(obj(receipt["response_body"])["id"]))
				if readErr != nil { return Result{}, reusedKey(key) }
				if err := tx.Commit(ctx); err != nil { return Result{}, err }
				return created(medicalReportDTO(replayed))
			}
			if !errors.Is(queryErr, pgx.ErrNoRows) { return Result{}, queryErr }
		}
	} else {
		existing, queryErr := one(ctx, tx, "SELECT to_jsonb(r) FROM medical_reports r WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL FOR UPDATE", id, scope.FamilyID, scope.BabyID)
		if errors.Is(queryErr, pgx.ErrNoRows) { return Result{}, notFound("MedicalReport", id) }
		if queryErr != nil { return Result{}, queryErr }
		if integer(existing["version"]) != baseVersion || baseVersion >= math.MaxInt32 { return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Medical report changed; reload before writing") }
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if operation == "delete" {
		// Reference deletion increments the projection version, not the report
		// version. Preserve the tombstone behavior; snapshot restore is separate.
		if _, err = tx.Exec(ctx, "UPDATE medical_reports SET deleted_at=$4,updated_at=$4 WHERE id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID, now); err != nil { return Result{}, err }
		if _, err = tx.Exec(ctx, "UPDATE timeline_entries SET deleted_at=$4,updated_at=$4,version=version+1 WHERE entity_type='medical' AND entity_id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID, now); err != nil { return Result{}, err }
	} else {
		values := Object{"updated_at": now}
		for _, field := range []struct{ wire, column string }{{"reportDate", "report_date"}, {"title", "title"}, {"hospital", "hospital"}, {"department", "department"}, {"diagnosis", "diagnosis"}, {"notes", "notes"}, {"items", "items"}} {
			value, exists := r.Body[field.wire]
			if !exists && operation != "create" { continue }
			if field.wire == "reportDate" { value, err = time.Parse("2006-01-02", text(value)) }
			if field.wire == "items" {
				if value == nil { value = []any{} }
				value, err = nullableJSONValue(value)
			}
			if err != nil { return Result{}, invalid("Invalid medical field "+field.wire) }
			values[field.column] = value
		}
		var row Object
		if operation == "create" {
			values["id"], values["family_id"], values["baby_id"], values["caregiver_id"] = id, scope.FamilyID, scope.BabyID, r.Principal.UserID
			values["created_at"], values["version"] = now, 1
			row, err = insertObject(ctx, tx, "medical_reports", values)
		} else {
			values["version"] = baseVersion+1
			row, err = updateColumns(ctx, tx, "medical_reports", id, values)
		}
		if err != nil { return Result{}, err }
		if attachments, supplied := r.Body["attachmentIds"]; supplied {
			if err = replaceMedicalAttachments(ctx, tx, scope, id, attachments); err != nil { return Result{}, err }
		}
		if err = writeMedicalProjection(ctx, tx, scope, row, operation == "create", now); err != nil { return Result{}, err }
		if operation == "create" {
			if growth := obj(r.Body["growthData"]); growth != nil {
				if err = insertMedicalGrowth(ctx, tx, scope, id, row["report_date"], growth, now); err != nil { return Result{}, err }
			}
			if key != "" {
				body, encodeErr := jsonText(Object{"id": id})
				if encodeErr != nil { return Result{}, encodeErr }
				if _, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,response_body,completed_at) VALUES($1,$2,$3,$4,200,$5::jsonb,$6)`, r.Principal.UserID, scope.FamilyID, key, requestHash, body, now); err != nil { return Result{}, err }
			}
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE family_sync_states SET cursor=$2,updated_at=$3 WHERE family_id=$1", scope.FamilyID, cursor+1, now); err != nil { return Result{}, err }
	if operation == "delete" { result, err = ok(Object{"id": id, "deleted": true}) } else {
		row, queryErr := readMedicalReport(ctx, tx, scope, id)
		if queryErr != nil { return Result{}, queryErr }
		if operation == "create" { result, err = created(medicalReportDTO(row)) } else { result, err = ok(medicalReportDTO(row)) }
	}
	if err != nil { return Result{}, err }
	if err = tx.Commit(ctx); err != nil { return Result{}, err }
	return result, nil
}
