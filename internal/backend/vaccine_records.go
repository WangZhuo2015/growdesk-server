package backend

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerVaccines() {
	s.Register("getVaccineSchedule", true, s.getVaccineSchedule)
	s.Register("getVaccineCatalog", false, s.getVaccineCatalog)
	s.Register("listVaccineRecords", false, s.listVaccineRecords)
	s.Register("createVaccineRecord", false, s.createVaccineRecord)
	s.Register("deleteVaccineRecord", false, s.deleteVaccineRecord)
	s.Register("listVaccineSelections", false, s.listVaccineSelections)
	s.Register("upsertVaccineSelection", false, s.upsertVaccineSelection)
}

func vaccineRecordDTO(row Object) Object {
	scheduled := dateValue(row["scheduled_date"])
	if scheduled == nil { scheduled = dateValue(row["administered_date"]) }
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "vaccineCode": row["vaccine_code"],
		"vaccineId": row["vaccine_id"], "doseNumber": row["dose_number"], "legacyName": row["legacy_name"], "legacyDose": row["legacy_dose"],
		"administeredDate": dateValue(row["administered_date"]), "scheduledDate": scheduled, "completedDate": dateValue(row["completed_date"]),
		"isCompleted": row["is_completed"], "clinic": row["clinic"], "batchNumber": row["batch_number"], "notes": row["notes"],
		"version": text(row["version"]), "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func vaccineSelectionDTO(row Object) Object {
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "vaccineId": row["vaccine_id"],
		"doseNumber": row["dose_number"], "selected": row["selected"], "completed": row["completed"], "version": row["version"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func (s *Server) listVaccineRecords(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		rows, err := many(ctx, q, "SELECT to_jsonb(v) FROM vaccine_records v WHERE family_id=$1 AND baby_id=$2 AND deleted_at IS NULL ORDER BY administered_date DESC,id DESC", scope.FamilyID, scope.BabyID)
		if err != nil { return Result{}, err }
		data := make([]Object, 0, len(rows))
		for _, row := range rows { data = append(data, vaccineRecordDTO(row)) }
		return ok(data)
	})
}

func vaccineProjection(ctx context.Context, tx pgx.Tx, scope Scope, record Object, occurred time.Time, details Object, now time.Time) error {
	raw, err := jsonText(details)
	if err != nil { return err }
	_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,created_at,updated_at)
		VALUES($1,$2,$3,'vaccine',$4,$5,$6,$7::jsonb,'ui_manual',1,$8,$8)
		ON CONFLICT(family_id,baby_id,entity_type,entity_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,
		summary=EXCLUDED.summary,details=EXCLUDED.details,deleted_at=NULL,version=timeline_entries.version+1,updated_at=EXCLUDED.updated_at`,
		newID(), scope.FamilyID, scope.BabyID, record["id"], occurred, "接种疫苗: "+text(record["vaccine_code"]), raw, now)
	return err
}

func (s *Server) createVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	key, hash := r.HTTP.Header.Get("Idempotency-Key"), ""
	if key != "" {
		var err error
		hash, err = documentBodyHash(r)
		if err != nil { return Result{}, err }
	}
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		if key != "" {
			receipt, err := one(ctx, tx, "SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3", r.Principal.UserID, scope.FamilyID, key)
			if err == nil {
				if text(receipt["request_hash"]) != hash { return Result{}, false, reusedKey(key) }
				row, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccine_records v WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL", obj(receipt["response_body"])["id"], scope.FamilyID, scope.BabyID)
				if err != nil { return Result{}, false, reusedKey(key) }
				result, err := created(vaccineRecordDTO(row)); return result, false, err
			}
			if !errors.Is(err, pgx.ErrNoRows) { return Result{}, false, err }
		}
		vaccineID, code := text(r.Body["vaccineId"]), text(r.Body["vaccineCode"])
		var vaccine Object
		var err error
		if vaccineID != "" { vaccine, err = one(ctx, tx, "SELECT to_jsonb(v) FROM vaccines v WHERE id=$1", vaccineID) } else {
			vaccine, err = one(ctx, tx, "SELECT to_jsonb(v) FROM vaccines v WHERE vaccine_code=$1", code)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			if vaccineID != "" { return Result{}, false, notFound("vaccine", vaccineID) }
			vaccine, err = nil, nil
		}
		if err != nil { return Result{}, false, err }
		day, err := time.Parse("2006-01-02", text(r.Body["administeredDate"]))
		if err != nil { return Result{}, false, invalid("Invalid administered date") }
		scheduled := day
		if date := text(r.Body["scheduledDate"]); date != "" {
			scheduled, err = time.Parse("2006-01-02", date)
			if err != nil { return Result{}, false, invalid("Invalid scheduled date") }
		}
		complete := true
		if value, supplied := r.Body["isCompleted"]; supplied { complete = boolean(value) }
		var completed any
		if complete {
			completed = day
			if date := text(r.Body["completedDate"]); date != "" {
				completed, err = time.Parse("2006-01-02", date)
				if err != nil { return Result{}, false, invalid("Invalid completion date") }
			}
		}
		now, id := time.Now().UTC().Truncate(time.Millisecond), newID()
		values := Object{"id": id, "family_id": scope.FamilyID, "baby_id": scope.BabyID, "caregiver_id": r.Principal.UserID,
			"vaccine_code": code, "vaccine_id": nil, "dose_number": r.Body["doseNumber"], "legacy_name": r.Body["legacyName"], "legacy_dose": r.Body["legacyDose"],
			"administered_date": day, "scheduled_date": scheduled, "completed_date": completed, "is_completed": complete,
			"clinic": r.Body["clinic"], "batch_number": r.Body["batchNumber"], "notes": r.Body["notes"], "version": 1, "created_at": now, "updated_at": now}
		if values["dose_number"] != nil { values["dose_number"] = integer(values["dose_number"]) }
		if vaccine != nil { values["vaccine_code"], values["vaccine_id"] = vaccine["vaccine_code"], vaccine["id"] }
		row, err := insertObject(ctx, tx, "vaccine_records", values)
		if err != nil { return Result{}, false, err }
		if complete {
			if err = vaccineProjection(ctx, tx, scope, row, day, Object{"clinic": row["clinic"], "batchNumber": row["batch_number"]}, now); err != nil { return Result{}, false, err }
		}
		if key != "" {
			body, err := jsonText(Object{"id": id})
			if err != nil { return Result{}, false, err }
			if _, err = tx.Exec(ctx, "INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,response_body,completed_at) VALUES($1,$2,$3,$4,200,$5::jsonb,$6)", r.Principal.UserID, scope.FamilyID, key, hash, body, now); err != nil { return Result{}, false, err }
		}
		result, err := created(vaccineRecordDTO(row)); return result, true, err
	})
}

func (s *Server) deleteVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		id := r.Params["id"]
		_, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccine_records v WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL FOR UPDATE", id, scope.FamilyID, scope.BabyID)
		if errors.Is(err, pgx.ErrNoRows) { return Result{}, false, notFound("VaccineRecord", id) }
		if err != nil { return Result{}, false, err }
		now := time.Now().UTC().Truncate(time.Millisecond)
		if _, err = tx.Exec(ctx, "UPDATE vaccine_records SET deleted_at=$4,updated_at=$4 WHERE id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID, now); err != nil { return Result{}, false, err }
		if _, err = tx.Exec(ctx, "UPDATE timeline_entries SET deleted_at=$4,updated_at=$4 WHERE entity_type='vaccine' AND entity_id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID, now); err != nil { return Result{}, false, err }
		result, err := ok(Object{"id": id, "deleted": true}); return result, true, err
	})
}

func (s *Server) listVaccineSelections(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		rows, err := many(ctx, q, "SELECT to_jsonb(v) FROM vaccine_selections v WHERE family_id=$1 AND baby_id=$2 ORDER BY vaccine_id,dose_number", scope.FamilyID, scope.BabyID)
		if err != nil { return Result{}, err }
		data := make([]Object, 0, len(rows))
		for _, row := range rows { data = append(data, vaccineSelectionDTO(row)) }
		return ok(data)
	})
}

func (s *Server) upsertVaccineSelection(ctx context.Context, r *Request) (Result, error) {
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		requested, dose := text(r.Body["vaccineId"]), integer(r.Body["doseNumber"])
		vaccine, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccines v WHERE id=$1 OR vaccine_code=$1 ORDER BY (id=$1) DESC LIMIT 1", requested)
		if errors.Is(err, pgx.ErrNoRows) { return Result{}, false, notFound("vaccine", requested) }
		if err != nil { return Result{}, false, err }
		existing, err := one(ctx, tx, "SELECT to_jsonb(s) FROM vaccine_selections s WHERE family_id=$1 AND baby_id=$2 AND vaccine_id=$3 AND dose_number=$4 FOR UPDATE", scope.FamilyID, scope.BabyID, vaccine["id"], dose)
		if errors.Is(err, pgx.ErrNoRows) { existing, err = nil, nil }
		if err != nil { return Result{}, false, err }
		version, id := int64(1), newID()
		selected, complete := true, false
		if existing != nil {
			id, selected, complete = text(existing["id"]), boolean(existing["selected"]), boolean(existing["completed"])
			version, err = nextCatalogVersion(existing, r.Body)
			if err != nil { return Result{}, false, err }
		}
		if value, supplied := r.Body["selected"]; supplied { selected = boolean(value) }
		if value, supplied := r.Body["completed"]; supplied { complete = boolean(value) }
		now := time.Now().UTC().Truncate(time.Millisecond)
		values := Object{"selected": selected, "completed": complete, "version": version, "updated_at": now}
		var selection Object
		if existing == nil {
			values["id"], values["family_id"], values["baby_id"], values["vaccine_id"], values["dose_number"], values["created_at"] = id, scope.FamilyID, scope.BabyID, vaccine["id"], dose, now
			selection, err = insertObject(ctx, tx, "vaccine_selections", values)
		} else { selection, err = updateColumns(ctx, tx, "vaccine_selections", id, values) }
		if err != nil { return Result{}, false, err }
		record, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccine_records v WHERE family_id=$1 AND baby_id=$2 AND vaccine_id=$3 AND dose_number=$4 AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE", scope.FamilyID, scope.BabyID, vaccine["id"], dose)
		if errors.Is(err, pgx.ErrNoRows) { record, err = nil, nil }
		if err != nil { return Result{}, false, err }
		if complete {
			day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
			label := "第" + strconv.FormatInt(dose, 10) + "剂"
			values := Object{"administered_date": day, "completed_date": day, "is_completed": true, "updated_at": now}
			if record == nil {
				values["id"], values["family_id"], values["baby_id"], values["caregiver_id"], values["vaccine_id"], values["vaccine_code"], values["dose_number"] = newID(), scope.FamilyID, scope.BabyID, r.Principal.UserID, vaccine["id"], vaccine["vaccine_code"], dose
				values["scheduled_date"], values["legacy_name"], values["legacy_dose"], values["version"], values["created_at"] = day, vaccine["name"], label, 1, now
				record, err = insertObject(ctx, tx, "vaccine_records", values)
			} else {
				version, versionErr := nextCatalogVersion(record, nil)
				if versionErr != nil { return Result{}, false, versionErr }
				values["version"] = version
				if record["scheduled_date"] == nil { values["scheduled_date"] = day }
				if record["legacy_name"] == nil { values["legacy_name"] = vaccine["name"] }
				if record["legacy_dose"] == nil { values["legacy_dose"] = label }
				record, err = updateColumns(ctx, tx, "vaccine_records", text(record["id"]), values)
			}
			if err != nil { return Result{}, false, err }
			if err = vaccineProjection(ctx, tx, scope, record, now, Object{"doseNumber": dose}, now); err != nil { return Result{}, false, err }
		} else if record != nil && boolean(record["is_completed"]) {
			if _, err = tx.Exec(ctx, "UPDATE vaccine_records SET deleted_at=$2,updated_at=$2,version=version+1 WHERE id=$1", record["id"], now); err != nil { return Result{}, false, err }
			if _, err = tx.Exec(ctx, "UPDATE timeline_entries SET deleted_at=$4,updated_at=$4,version=version+1 WHERE family_id=$1 AND baby_id=$2 AND entity_type='vaccine' AND entity_id=$3 AND deleted_at IS NULL", scope.FamilyID, scope.BabyID, record["id"], now); err != nil { return Result{}, false, err }
		}
		result, err := ok(vaccineSelectionDTO(selection)); return result, true, err
	})
}
