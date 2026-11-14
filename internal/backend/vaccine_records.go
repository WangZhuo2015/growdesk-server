package backend

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerVaccines() {
	s.Register("getVaccineSchedule", true, s.getVaccineSchedule)
	s.Register("getVaccineCatalog", false, s.getVaccineCatalog)
	s.Register("listVaccineRecords", false, s.listVaccineRecords)
	s.Register("createVaccineRecord", false, s.createVaccineRecord)
	s.Register("updateVaccineRecord", false, s.updateVaccineRecord)
	s.Register("deleteVaccineRecord", false, s.deleteVaccineRecord)
	s.Register("listVaccineSelections", false, s.listVaccineSelections)
	s.Register("upsertVaccineSelection", false, s.upsertVaccineSelection)
}

func vaccineRecordDTO(row Object) Object {
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "vaccineCode": row["vaccine_code"],
		"vaccineId": row["vaccine_id"], "doseNumber": row["dose_number"], "legacyName": row["legacy_name"], "legacyDose": row["legacy_dose"],
		"administeredDate": dateValue(row["administered_date"]), "scheduledDate": dateValue(row["scheduled_date"]), "completedDate": dateValue(row["completed_date"]),
		"isCompleted": row["is_completed"], "clinic": row["clinic"], "batchNumber": row["batch_number"], "notes": row["notes"],
		"manufacturer": row["manufacturer"], "productName": row["product_name"], "traceabilityCode": row["traceability_code"], "injectionSite": row["injection_site"],
		"version": text(row["version"]), "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func vaccineSelectionDTO(row Object) Object {
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "vaccineId": row["vaccine_id"],
		"doseNumber": row["dose_number"], "selected": row["selected"], "completed": row["completed"], "version": row["version"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

// A checkbox is a preference, never evidence of vaccination. This expression
// is also used for snapshot/export so stale compatibility columns cannot
// resurrect a completion after its record is corrected or deleted.
const vaccineSelectionProjection = `to_jsonb(s) || jsonb_build_object('completed', EXISTS (
	SELECT 1 FROM vaccine_records r WHERE r.family_id=s.family_id AND r.baby_id=s.baby_id
	AND r.vaccine_id=s.vaccine_id AND r.dose_number=s.dose_number
	AND r.is_completed=true AND r.deleted_at IS NULL))`

func (s *Server) listVaccineRecords(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		rows, err := many(ctx, q, "SELECT to_jsonb(v) FROM vaccine_records v WHERE family_id=$1 AND baby_id=$2 AND deleted_at IS NULL ORDER BY administered_date DESC,id DESC", scope.FamilyID, scope.BabyID)
		if err != nil {
			return Result{}, err
		}
		data := make([]Object, 0, len(rows))
		for _, row := range rows {
			data = append(data, vaccineRecordDTO(row))
		}
		return ok(data)
	})
}

func vaccineProjection(ctx context.Context, tx pgx.Tx, scope Scope, record Object, now time.Time) error {
	if !boolean(record["is_completed"]) {
		_, err := tx.Exec(ctx, `UPDATE timeline_entries SET deleted_at=$4,updated_at=$4,version=version+1
			WHERE family_id=$1 AND baby_id=$2 AND entity_type='vaccine' AND entity_id=$3 AND deleted_at IS NULL`, scope.FamilyID, scope.BabyID, record["id"], now)
		return err
	}
	day, err := time.Parse("2006-01-02", text(dateValue(record["administered_date"])))
	if err != nil {
		return invalid("Invalid administered date")
	}
	details := Object{"doseNumber": record["dose_number"], "clinic": record["clinic"], "batchNumber": record["batch_number"],
		"manufacturer": record["manufacturer"], "productName": record["product_name"], "traceabilityCode": record["traceability_code"], "injectionSite": record["injection_site"]}
	raw, err := jsonText(details)
	if err != nil {
		return err
	}
	label := text(record["legacy_name"])
	if strings.TrimSpace(label) == "" {
		label = text(record["vaccine_code"])
	}
	_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,created_at,updated_at)
		VALUES($1,$2,$3,'vaccine',$4,$5,$6,$7::jsonb,'ui_manual',1,$8,$8)
		ON CONFLICT(family_id,baby_id,entity_type,entity_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,
		summary=EXCLUDED.summary,details=EXCLUDED.details,deleted_at=NULL,version=timeline_entries.version+1,updated_at=EXCLUDED.updated_at`,
		newID(), scope.FamilyID, scope.BabyID, record["id"], day, "接种疫苗: "+label, raw, now)
	return err
}

// The old required administered_date column is retained as a compatibility
// anchor for plans. It never makes a plan completed. A transition to completed
// must explicitly supply the actual administration date.
func vaccineRecordValues(body, existing Object) (Object, error) {
	values := Object{}
	for _, field := range []struct{ wire, column string }{
		{"vaccineCode", "vaccine_code"}, {"vaccineId", "vaccine_id"}, {"doseNumber", "dose_number"},
		{"legacyName", "legacy_name"}, {"legacyDose", "legacy_dose"}, {"clinic", "clinic"}, {"batchNumber", "batch_number"},
		{"manufacturer", "manufacturer"}, {"productName", "product_name"}, {"traceabilityCode", "traceability_code"}, {"injectionSite", "injection_site"}, {"notes", "notes"},
	} {
		value, provided := body[field.wire]
		if provided || existing == nil {
			values[field.column] = value
		}
	}
	if value, supplied := values["vaccine_code"]; supplied && strings.TrimSpace(text(value)) == "" {
		return nil, invalid("Vaccine name or code is required")
	}
	if value := values["dose_number"]; value != nil {
		values["dose_number"] = integer(value)
	}
	complete := existing == nil || boolean(existing["is_completed"])
	if value, supplied := body["isCompleted"]; supplied {
		complete = boolean(value)
	}
	if existing != nil && !boolean(existing["is_completed"]) && complete {
		if _, explicit := body["administeredDate"]; !explicit {
			return nil, invalid("Enter the actual administration date before completing a planned vaccination")
		}
	}
	dayText := text(body["administeredDate"])
	if _, provided := body["administeredDate"]; !provided && existing != nil {
		dayText = text(dateValue(existing["administered_date"]))
	}
	day, err := time.Parse("2006-01-02", dayText)
	if err != nil {
		return nil, invalid("Enter a complete YYYY-MM-DD administration date")
	}
	var scheduled any
	if existing != nil {
		scheduled = dateValue(existing["scheduled_date"])
	}
	if value, supplied := body["scheduledDate"]; supplied {
		scheduled = value
	}
	if scheduled != nil {
		scheduled, err = time.Parse("2006-01-02", text(scheduled))
		if err != nil {
			return nil, invalid("Invalid scheduled date")
		}
	}
	if !complete && scheduled == nil {
		return nil, invalid("A planned vaccination requires an explicit scheduled date")
	}
	if !complete {
		// This required legacy column is only an appointment anchor for plans.
		day = scheduled.(time.Time)
	}
	if completed, supplied := body["completedDate"]; supplied {
		if complete && (completed == nil || text(completed) != dayText) {
			return nil, invalid("Completed date must match the actual administration date")
		}
		if !complete && completed != nil {
			return nil, invalid("A planned vaccination cannot have a completed date")
		}
	}
	values["administered_date"], values["scheduled_date"], values["is_completed"], values["completed_date"] = day, scheduled, complete, nil
	if complete {
		values["completed_date"] = day
	}
	return values, nil
}

func resolveVaccineRecord(ctx context.Context, q Querier, values Object, existing Object) error {
	id, hasID := values["vaccine_id"]
	code, hasCode := values["vaccine_code"]
	if existing != nil && !hasID && !hasCode {
		return nil
	}
	if existing != nil && hasID && id == nil {
		// Explicit null unlinks a guessed catalog match while retaining the
		// booklet's own name/code. No dose or product metadata is inferred.
		return nil
	}
	var vaccine Object
	var err error
	if text(id) != "" {
		vaccine, err = one(ctx, q, "SELECT to_jsonb(v) FROM vaccines v WHERE id=$1", id)
	} else {
		vaccine, err = one(ctx, q, "SELECT to_jsonb(v) FROM vaccines v WHERE vaccine_code=$1", code)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if text(id) != "" {
			return notFound("vaccine", text(id))
		}
		values["vaccine_id"] = nil
		return nil
	}
	if err != nil {
		return err
	}
	values["vaccine_id"], values["vaccine_code"] = vaccine["id"], vaccine["vaccine_code"]
	return nil
}

func (s *Server) createVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	key, hash := r.HTTP.Header.Get("Idempotency-Key"), ""
	if key != "" {
		var err error
		hash, err = documentBodyHash(r)
		if err != nil {
			return Result{}, err
		}
	}
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		if key != "" {
			receipt, err := one(ctx, tx, "SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3", r.Principal.UserID, scope.FamilyID, key)
			if err == nil {
				if text(receipt["request_hash"]) != hash {
					return Result{}, false, reusedKey(key)
				}
				row, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccine_records v WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL", obj(receipt["response_body"])["id"], scope.FamilyID, scope.BabyID)
				if err != nil {
					return Result{}, false, reusedKey(key)
				}
				result, err := created(vaccineRecordDTO(row))
				return result, false, err
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return Result{}, false, err
			}
		}
		values, err := vaccineRecordValues(r.Body, nil)
		if err != nil {
			return Result{}, false, err
		}
		if err = resolveVaccineRecord(ctx, tx, values, nil); err != nil {
			return Result{}, false, err
		}
		now, id := time.Now().UTC().Truncate(time.Millisecond), newID()
		values["id"], values["family_id"], values["baby_id"], values["caregiver_id"] = id, scope.FamilyID, scope.BabyID, r.Principal.UserID
		values["version"], values["created_at"], values["updated_at"] = 1, now, now
		row, err := insertObject(ctx, tx, "vaccine_records", values)
		if err != nil {
			return Result{}, false, err
		}
		if err = vaccineProjection(ctx, tx, scope, row, now); err != nil {
			return Result{}, false, err
		}
		if key != "" {
			body, err := jsonText(Object{"id": id})
			if err != nil {
				return Result{}, false, err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,response_body,completed_at) VALUES($1,$2,$3,$4,200,$5::jsonb,$6)", r.Principal.UserID, scope.FamilyID, key, hash, body, now); err != nil {
				return Result{}, false, err
			}
		}
		result, err := created(vaccineRecordDTO(row))
		return result, true, err
	})
}

func (s *Server) updateVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	baseVersion, err := parseWireVersion(text(r.Body["baseVersion"]))
	if err != nil {
		return Result{}, err
	}
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		id := r.Params["id"]
		existing, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccine_records v WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL FOR UPDATE", id, scope.FamilyID, scope.BabyID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, false, notFound("VaccineRecord", id)
		}
		if err != nil {
			return Result{}, false, err
		}
		if integer(existing["version"]) != baseVersion || baseVersion >= math.MaxInt32 {
			return Result{}, false, apiError(409, "CONCURRENCY_CONFLICT", "Vaccination record changed; reload before saving")
		}
		values, err := vaccineRecordValues(r.Body, existing)
		if err != nil {
			return Result{}, false, err
		}
		if err = resolveVaccineRecord(ctx, tx, values, existing); err != nil {
			return Result{}, false, err
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		values["updated_at"], values["version"] = now, baseVersion+1
		row, err := updateColumns(ctx, tx, "vaccine_records", id, values)
		if err != nil {
			return Result{}, false, err
		}
		if err = vaccineProjection(ctx, tx, scope, row, now); err != nil {
			return Result{}, false, err
		}
		result, err := ok(vaccineRecordDTO(row))
		return result, true, err
	})
}

func (s *Server) deleteVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	versionValue, hasVersion := r.Body["baseVersion"]
	if queryVersions, supplied := r.HTTP.URL.Query()["baseVersion"]; supplied {
		if len(queryVersions) != 1 {
			return Result{}, invalid("Supply baseVersion only once")
		}
		queryVersion := queryVersions[0]
		if hasVersion && text(versionValue) != queryVersion {
			return Result{}, invalid("Body and query baseVersion must agree")
		}
		versionValue, hasVersion = queryVersion, true
	}
	var baseVersion int64
	if hasVersion {
		var err error
		baseVersion, err = parseWireVersion(text(versionValue))
		if err != nil {
			return Result{}, err
		}
	}
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		id := r.Params["id"]
		existing, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccine_records v WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL FOR UPDATE", id, scope.FamilyID, scope.BabyID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, false, notFound("VaccineRecord", id)
		}
		if err != nil {
			return Result{}, false, err
		}
		version := integer(existing["version"])
		if (hasVersion && version != baseVersion) || version >= math.MaxInt32 {
			return Result{}, false, apiError(409, "CONCURRENCY_CONFLICT", "Vaccination record changed; reload before deleting")
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		if _, err = tx.Exec(ctx, "UPDATE vaccine_records SET deleted_at=$4,updated_at=$4,version=version+1 WHERE id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID, now); err != nil {
			return Result{}, false, err
		}
		if _, err = tx.Exec(ctx, "UPDATE timeline_entries SET deleted_at=$4,updated_at=$4,version=version+1 WHERE entity_type='vaccine' AND entity_id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL", id, scope.FamilyID, scope.BabyID, now); err != nil {
			return Result{}, false, err
		}
		result, err := ok(Object{"id": id, "deleted": true})
		return result, true, err
	})
}

func (s *Server) listVaccineSelections(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		rows, err := many(ctx, q, "SELECT "+vaccineSelectionProjection+" FROM vaccine_selections s WHERE s.family_id=$1 AND s.baby_id=$2 ORDER BY s.vaccine_id,s.dose_number", scope.FamilyID, scope.BabyID)
		if err != nil {
			return Result{}, err
		}
		data := make([]Object, 0, len(rows))
		for _, row := range rows {
			data = append(data, vaccineSelectionDTO(row))
		}
		return ok(data)
	})
}

func (s *Server) upsertVaccineSelection(ctx context.Context, r *Request) (Result, error) {
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		requested, dose := text(r.Body["vaccineId"]), integer(r.Body["doseNumber"])
		vaccine, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccines v WHERE id=$1 OR vaccine_code=$1 ORDER BY (id=$1) DESC LIMIT 1", requested)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, false, notFound("vaccine", requested)
		}
		if err != nil {
			return Result{}, false, err
		}
		existing, err := one(ctx, tx, "SELECT "+vaccineSelectionProjection+" FROM vaccine_selections s WHERE s.family_id=$1 AND s.baby_id=$2 AND s.vaccine_id=$3 AND s.dose_number=$4 FOR UPDATE OF s", scope.FamilyID, scope.BabyID, vaccine["id"], dose)
		if errors.Is(err, pgx.ErrNoRows) {
			existing, err = nil, nil
		}
		if err != nil {
			return Result{}, false, err
		}
		var completed bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vaccine_records WHERE family_id=$1 AND baby_id=$2 AND vaccine_id=$3 AND dose_number=$4 AND is_completed=true AND deleted_at IS NULL)`, scope.FamilyID, scope.BabyID, vaccine["id"], dose).Scan(&completed); err != nil {
			return Result{}, false, err
		}
		if value, supplied := r.Body["completed"]; supplied && boolean(value) != completed {
			return Result{}, false, apiError(400, "VACCINE_RECORD_REQUIRED", "接种状态由实际记录确定，请在接种记录中填写或更正接种日期。")
		}
		version, id, selected := int64(1), newID(), true
		if existing != nil {
			id, selected = text(existing["id"]), boolean(existing["selected"])
			version, err = nextCatalogVersion(existing, r.Body)
			if err != nil {
				return Result{}, false, err
			}
		}
		if value, supplied := r.Body["selected"]; supplied {
			selected = boolean(value)
		}
		if existing != nil && selected == boolean(existing["selected"]) {
			result, err := ok(vaccineSelectionDTO(existing))
			return result, false, err
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		values := Object{"selected": selected, "completed": completed, "version": version, "updated_at": now}
		var selection Object
		if existing == nil {
			values["id"], values["family_id"], values["baby_id"], values["vaccine_id"], values["dose_number"], values["created_at"] = id, scope.FamilyID, scope.BabyID, vaccine["id"], dose, now
			selection, err = insertObject(ctx, tx, "vaccine_selections", values)
		} else {
			selection, err = updateColumns(ctx, tx, "vaccine_selections", id, values)
		}
		if err != nil {
			return Result{}, false, err
		}
		result, err := ok(vaccineSelectionDTO(selection))
		return result, true, err
	})
}
