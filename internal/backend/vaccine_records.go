package backend

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const vaccineLedgerHeader = "x-growdesk-representation"

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

func wantsVaccineLedger(r *Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.HTTP.Header.Get(vaccineLedgerHeader)), "ledger")
}

func vaccineStatus(row Object) string {
	return vaccineStatusAt(row, time.Now())
}

func vaccineStatusAt(row Object, now time.Time) string {
	status := text(row["record_status"])
	if status == "" {
		switch {
		case boolean(row["is_completed"]):
			status = "completed"
		case row["scheduled_date"] != nil:
			status = "planned"
		default:
			status = "needs_review"
		}
	}
	if status == "completed" {
		actual := storedVaccineDate(row["administered_date"])
		if actual == nil {
			actual = storedVaccineDate(row["completed_date"])
		}
		today, err := vaccineTodayShanghai(now)
		if actual == nil || err != nil || actual.Format("2006-01-02") > today {
			return "needs_review"
		}
	}
	return status
}

func vaccineRecordDTO(row Object, ledger bool) Object {
	status := vaccineStatus(row)
	administered := dateValue(row["administered_date"])
	scheduled := dateValue(row["scheduled_date"])
	var completed any
	if status == "completed" {
		if administered == nil {
			administered = dateValue(row["completed_date"])
		}
		completed = administered
	}
	if !ledger {
		// The old iOS snapshot has a required administeredDate string. Keep its
		// historical wire contract for completed/planned rows, while the opt-in
		// ledger representation below exposes the real nullable actual date.
		if status == "planned" {
			administered = scheduled
		}
		if status == "completed" && scheduled == nil {
			scheduled = administered
		}
	}
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "vaccineCode": row["vaccine_code"],
		"vaccineId": row["vaccine_id"], "doseNumber": row["dose_number"], "legacyName": row["legacy_name"], "legacyDose": row["legacy_dose"],
		"recordStatus": status, "administeredDate": administered, "scheduledDate": scheduled, "completedDate": completed,
		"isCompleted": status == "completed", "manufacturer": row["manufacturer"], "clinic": row["clinic"],
		"batchNumber": row["batch_number"], "traceCode": row["trace_code"], "administrationRoute": row["administration_route"],
		"injectionSite": row["injection_site"], "notes": row["notes"], "sourceText": row["source_text"],
		"version": text(row["version"]), "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func vaccineSelectionDTO(row Object) Object {
	return Object{"id": row["id"], "familyId": row["family_id"], "babyId": row["baby_id"], "vaccineId": row["vaccine_id"],
		"doseNumber": row["dose_number"], "selected": row["selected"], "completed": row["completed"], "version": row["version"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}

func readVaccineRecord(ctx context.Context, q Querier, scope Scope, id string, lock bool) (Object, error) {
	query := "SELECT to_jsonb(v) FROM vaccine_records v WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL"
	if lock {
		query += " FOR UPDATE"
	}
	row, err := one(ctx, q, query, id, scope.FamilyID, scope.BabyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("VaccineRecord", id)
	}
	return row, err
}

func (s *Server) listVaccineRecords(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		where := "family_id=$1 AND baby_id=$2 AND deleted_at IS NULL"
		if !wantsVaccineLedger(r) {
			// needs_review may have neither date. Do not fabricate one for the
			// old iOS client, whose pinned decoder requires administeredDate.
			where += " AND record_status <> 'needs_review'"
		}
		rows, err := many(ctx, q, "SELECT to_jsonb(v) FROM vaccine_records v WHERE "+where+
			" ORDER BY COALESCE(administered_date,scheduled_date) DESC NULLS LAST,updated_at DESC,id DESC", scope.FamilyID, scope.BabyID)
		if err != nil {
			return Result{}, err
		}
		data := make([]Object, 0, len(rows))
		ledger := wantsVaccineLedger(r)
		now := time.Now()
		for _, row := range rows {
			if !ledger && vaccineStatusAt(row, now) == "needs_review" {
				continue
			}
			data = append(data, vaccineRecordDTO(row, ledger))
		}
		return ok(data)
	})
}

func parseVaccineDate(value any, field string) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	raw := text(value)
	parsed, err := time.Parse("2006-01-02", raw)
	if err != nil || parsed.Format("2006-01-02") != raw {
		return nil, invalid("Invalid " + field + " date")
	}
	return &parsed, nil
}

func storedVaccineDate(value any) *time.Time {
	if value == nil {
		return nil
	}
	parsed, err := time.Parse("2006-01-02", text(dateValue(value)))
	if err != nil {
		return nil
	}
	return &parsed
}

func vaccineTodayShanghai(now time.Time) (string, error) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return "", errors.New("Asia/Shanghai location data is unavailable")
	}
	return now.In(location).Format("2006-01-02"), nil
}

func validateActualVaccineDate(date *time.Time, now time.Time) error {
	if date == nil {
		return nil
	}
	today, err := vaccineTodayShanghai(now)
	if err != nil {
		return err
	}
	if date.Format("2006-01-02") > today {
		return invalid("administeredDate cannot be in the future in Asia/Shanghai")
	}
	return nil
}

func vaccineRecordStatus(body Object, existing Object) (string, bool, error) {
	if raw, supplied := body["recordStatus"]; supplied {
		status := text(raw)
		if status != "completed" && status != "planned" && status != "needs_review" {
			return "", true, invalid("Invalid recordStatus")
		}
		if rawCompleted, legacy := body["isCompleted"]; legacy && boolean(rawCompleted) != (status == "completed") {
			return "", true, invalid("recordStatus conflicts with isCompleted")
		}
		return status, true, nil
	}
	if existing != nil {
		if rawCompleted, supplied := body["isCompleted"]; supplied {
			if boolean(rawCompleted) {
				return "completed", false, nil
			}
			return "planned", false, nil
		}
		return vaccineStatus(existing), false, nil
	}
	if rawCompleted, supplied := body["isCompleted"]; supplied {
		if boolean(rawCompleted) {
			return "completed", false, nil
		}
		if body["scheduledDate"] != nil || body["administeredDate"] != nil {
			return "planned", false, nil
		}
		return "needs_review", false, nil
	}
	if body["scheduledDate"] != nil && body["administeredDate"] == nil {
		return "planned", false, nil
	}
	return "completed", false, nil
}

// vaccineLifecycleValues merges the canonical lifecycle fields. A legacy
// incomplete POST used administeredDate as an appointment date; it is moved
// into scheduledDate and stored with a null actual date.
func vaccineLifecycleValues(body Object, existing Object, ledger bool, now time.Time) (Object, error) {
	status, explicitStatus, err := vaccineRecordStatus(body, existing)
	if err != nil {
		return nil, err
	}
	if status == "needs_review" && !ledger {
		return nil, apiError(400, "VACCINE_LEDGER_REQUIRED", "needs_review records require x-growdesk-representation: ledger")
	}

	administered := storedVaccineDate(nil)
	scheduled := storedVaccineDate(nil)
	if existing != nil {
		administered = storedVaccineDate(existing["administered_date"])
		scheduled = storedVaccineDate(existing["scheduled_date"])
	}
	if value, supplied := body["administeredDate"]; supplied {
		administered, err = parseVaccineDate(value, "administeredDate")
		if err != nil {
			return nil, err
		}
	}
	if value, supplied := body["scheduledDate"]; supplied {
		scheduled, err = parseVaccineDate(value, "scheduledDate")
		if err != nil {
			return nil, err
		}
	}
	var completedAlias *time.Time
	if value, supplied := body["completedDate"]; supplied {
		completedAlias, err = parseVaccineDate(value, "completedDate")
		if err != nil {
			return nil, err
		}
		if status == "completed" && hasKey(body, "administeredDate") {
			administeredSupplied, parseErr := parseVaccineDate(body["administeredDate"], "administeredDate")
			if parseErr != nil {
				return nil, parseErr
			}
			if !sameVaccineDate(administeredSupplied, completedAlias) {
				return nil, invalid("completedDate must match administeredDate")
			}
		}
		if status == "completed" && !hasKey(body, "administeredDate") {
			administered = completedAlias
		}
		if status != "completed" && completedAlias != nil {
			return nil, invalid("completedDate is only valid for a completed record")
		}
	}

	if status == "planned" {
		legacyAppointmentAlias := existing == nil && !ledger && !explicitStatus && hasKey(body, "administeredDate") && administered != nil
		if hasKey(body, "administeredDate") && administered != nil && !legacyAppointmentAlias {
			return nil, invalid("planned records cannot contain administeredDate; provide scheduledDate")
		}
		if scheduled == nil && legacyAppointmentAlias {
			scheduled = administered
		}
		if scheduled == nil {
			return nil, invalid("scheduledDate is required for a planned record")
		}
		administered = nil
	} else if status == "completed" {
		if administered == nil {
			return nil, invalid("administeredDate is required for a completed record")
		}
		if err = validateActualVaccineDate(administered, now); err != nil {
			return nil, err
		}
	}

	var completed any
	if status == "completed" {
		completed = *administered
	}
	var actualValue, scheduledValue any
	if administered != nil {
		actualValue = *administered
	}
	if scheduled != nil {
		scheduledValue = *scheduled
	}
	return Object{"record_status": status, "administered_date": actualValue, "scheduled_date": scheduledValue,
		"completed_date": completed, "is_completed": status == "completed"}, nil
}

func sameVaccineDate(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Format("2006-01-02") == right.Format("2006-01-02")
}

func hasKey(value Object, key string) bool {
	_, present := value[key]
	return present
}

func nullableBodyValue(body Object, wire string, existing Object, column string, create bool) any {
	value, supplied := body[wire]
	if supplied {
		return nullableString(value)
	}
	if !create && existing != nil {
		return existing[column]
	}
	return nil
}

func vaccineReference(ctx context.Context, q Querier, body Object, existing Object, create bool) (any, string, any, error) {
	code := ""
	var vaccineID any
	var legacyName any
	if !create && existing != nil {
		code = text(existing["vaccine_code"])
		vaccineID = existing["vaccine_id"]
		legacyName = existing["legacy_name"]
	}
	if value, supplied := body["legacyName"]; supplied {
		legacyName = nullableString(value)
	}
	requestedCode, codeSupplied := body["vaccineCode"]
	requestedID, idSupplied := body["vaccineId"]
	if codeSupplied {
		code = strings.TrimSpace(text(requestedCode))
	}
	if idSupplied && requestedID == nil && !codeSupplied {
		return nil, "", nil, invalid("Provide vaccineCode when clearing vaccineId")
	}
	if idSupplied && requestedID == nil {
		if code == "" {
			return nil, "", nil, invalid("Provide vaccineCode when clearing vaccineId")
		}
		if strings.TrimSpace(text(legacyName)) == "" {
			legacyName = code
		}
		// An explicit null is intentional: keep the user's unmatched/manual
		// identity even when its free-form code resembles a catalog code.
		return nil, code, legacyName, nil
	}
	lookup := ""
	if idSupplied {
		lookup = strings.TrimSpace(text(requestedID))
	} else if codeSupplied {
		lookup = code
	}
	if lookup == "" {
		if create {
			return nil, "", nil, invalid("vaccineId or vaccineCode is required")
		}
		return vaccineID, code, legacyName, nil
	}
	vaccine, err := one(ctx, q, "SELECT to_jsonb(v) FROM vaccines v WHERE id=$1 OR vaccine_code=$1 ORDER BY (id=$1) DESC LIMIT 1", lookup)
	if errors.Is(err, pgx.ErrNoRows) {
		if idSupplied && requestedID != nil {
			return nil, "", nil, notFound("vaccine", lookup)
		}
		if code == "" {
			return nil, "", nil, invalid("vaccineId or vaccineCode is required")
		}
		if strings.TrimSpace(text(legacyName)) == "" {
			legacyName = code
		}
		return nil, code, legacyName, nil
	}
	if err != nil {
		return nil, "", nil, err
	}
	if codeSupplied && code != "" && code != text(vaccine["vaccine_code"]) && code != lookup {
		return nil, "", nil, invalid("vaccineCode does not match vaccineId")
	}
	if legacyName == nil || strings.TrimSpace(text(legacyName)) == "" {
		legacyName = vaccine["name"]
	}
	return vaccine["id"], text(vaccine["vaccine_code"]), legacyName, nil
}

func vaccineRecordFields(body Object, existing Object, create bool) Object {
	fields := Object{}
	for _, field := range []struct{ wire, column string }{
		{"manufacturer", "manufacturer"}, {"clinic", "clinic"}, {"batchNumber", "batch_number"},
		{"traceCode", "trace_code"}, {"administrationRoute", "administration_route"},
		{"injectionSite", "injection_site"}, {"notes", "notes"}, {"sourceText", "source_text"},
		{"legacyDose", "legacy_dose"},
	} {
		fields[field.column] = nullableBodyValue(body, field.wire, existing, field.column, create)
	}
	if value, supplied := body["doseNumber"]; supplied {
		if value == nil {
			fields["dose_number"] = nil
		} else {
			fields["dose_number"] = integer(value)
		}
	} else if create {
		fields["dose_number"] = nil
	} else {
		fields["dose_number"] = existing["dose_number"]
	}
	return fields
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
	ledger := wantsVaccineLedger(r)
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		if key != "" {
			receipt, err := one(ctx, tx, "SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3", r.Principal.UserID, scope.FamilyID, key)
			if err == nil {
				if text(receipt["request_hash"]) != hash {
					return Result{}, false, reusedKey(key)
				}
				row, err := readVaccineRecord(ctx, tx, scope, text(obj(receipt["response_body"])["id"]), false)
				if err != nil {
					return Result{}, false, reusedKey(key)
				}
				if !ledger && vaccineStatus(row) == "needs_review" {
					return Result{}, false, reusedKey(key)
				}
				result, err := created(vaccineRecordDTO(row, ledger))
				return result, false, err
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return Result{}, false, err
			}
		}
		vaccineID, code, legacyName, err := vaccineReference(ctx, tx, r.Body, nil, true)
		if err != nil {
			return Result{}, false, err
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		lifecycle, err := vaccineLifecycleValues(r.Body, nil, ledger, now)
		if err != nil {
			return Result{}, false, err
		}
		id := newID()
		values := vaccineRecordFields(r.Body, nil, true)
		for key, value := range lifecycle {
			values[key] = value
		}
		values["id"], values["family_id"], values["baby_id"], values["caregiver_id"] = id, scope.FamilyID, scope.BabyID, r.Principal.UserID
		values["vaccine_id"], values["vaccine_code"], values["legacy_name"] = vaccineID, code, legacyName
		values["version"], values["created_at"], values["updated_at"] = 1, now, now
		row, err := insertObject(ctx, tx, "vaccine_records", values)
		if err != nil {
			return Result{}, false, err
		}
		if vaccineStatus(row) == "completed" {
			if err = vaccineProjection(ctx, tx, scope, row, *storedVaccineDate(row["administered_date"]), vaccineDetails(row), now); err != nil {
				return Result{}, false, err
			}
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
		result, err := created(vaccineRecordDTO(row, ledger))
		return result, true, err
	})
}

func vaccineProjection(ctx context.Context, tx pgx.Tx, scope Scope, record Object, occurred time.Time, details Object, now time.Time) error {
	raw, err := jsonText(details)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,created_at,updated_at)
		VALUES($1,$2,$3,'vaccine',$4,$5,$6,$7::jsonb,'ui_manual',1,$8,$8)
		ON CONFLICT(family_id,baby_id,entity_type,entity_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,
		summary=EXCLUDED.summary,details=EXCLUDED.details,deleted_at=NULL,version=timeline_entries.version+1,updated_at=EXCLUDED.updated_at`,
		newID(), scope.FamilyID, scope.BabyID, record["id"], occurred, "接种疫苗: "+text(record["vaccine_code"]), raw, now)
	return err
}

func vaccineDetails(row Object) Object {
	return Object{"doseNumber": row["dose_number"], "manufacturer": row["manufacturer"], "batchNumber": row["batch_number"],
		"traceCode": row["trace_code"], "administrationRoute": row["administration_route"],
		"injectionSite": row["injection_site"], "clinic": row["clinic"]}
}

func syncVaccineTimeline(ctx context.Context, tx pgx.Tx, scope Scope, row Object, now time.Time) error {
	id := text(row["id"])
	if vaccineStatus(row) != "completed" {
		_, err := tx.Exec(ctx, `UPDATE timeline_entries SET deleted_at=$4,updated_at=$4,version=version+1
			WHERE entity_type='vaccine' AND entity_id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL`,
			id, scope.FamilyID, scope.BabyID, now)
		return err
	}
	administered := storedVaccineDate(row["administered_date"])
	if administered == nil {
		return invalid("administeredDate is required for a completed record")
	}
	return vaccineProjection(ctx, tx, scope, row, *administered, vaccineDetails(row), now)
}

func (s *Server) updateVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	baseVersion, err := parseWireVersion(text(r.Body["baseVersion"]))
	if err != nil {
		return Result{}, err
	}
	if baseVersion >= math.MaxInt32 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Vaccine record version is exhausted")
	}
	ledger := wantsVaccineLedger(r)
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		id := r.Params["id"]
		existing, err := readVaccineRecord(ctx, tx, scope, id, true)
		if err != nil {
			return Result{}, false, err
		}
		if integer(existing["version"]) != baseVersion {
			return Result{}, false, apiError(409, "CONCURRENCY_CONFLICT", "Vaccine record changed; reload before saving")
		}
		if !ledger && vaccineStatus(existing) == "needs_review" {
			return Result{}, false, apiError(409, "VACCINE_LEDGER_REQUIRED", "needs_review records require x-growdesk-representation: ledger")
		}
		vaccineID, code, legacyName, err := vaccineReference(ctx, tx, r.Body, existing, false)
		if err != nil {
			return Result{}, false, err
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		lifecycle, err := vaccineLifecycleValues(r.Body, existing, ledger, now)
		if err != nil {
			return Result{}, false, err
		}
		values := vaccineRecordFields(r.Body, existing, false)
		for key, value := range lifecycle {
			values[key] = value
		}
		values["vaccine_id"], values["vaccine_code"], values["legacy_name"] = vaccineID, code, legacyName
		values["version"], values["updated_at"] = baseVersion+1, now
		row, err := updateColumns(ctx, tx, "vaccine_records", id, values)
		if err != nil {
			return Result{}, false, err
		}
		if err = syncVaccineTimeline(ctx, tx, scope, row, now); err != nil {
			return Result{}, false, err
		}
		result, err := ok(vaccineRecordDTO(row, ledger))
		return result, true, err
	})
}

func (s *Server) deleteVaccineRecord(ctx context.Context, r *Request) (Result, error) {
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		id := r.Params["id"]
		row, err := readVaccineRecord(ctx, tx, scope, id, true)
		if err != nil {
			return Result{}, false, err
		}
		if raw := r.HTTP.URL.Query().Get("baseVersion"); raw != "" {
			baseVersion, parseErr := parseWireVersion(raw)
			if parseErr != nil {
				return Result{}, false, parseErr
			}
			if integer(row["version"]) != baseVersion {
				return Result{}, false, apiError(409, "CONCURRENCY_CONFLICT", "Vaccine record changed; reload before deleting")
			}
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

const vaccineSelectionCompletedProjection = `to_jsonb(s) || jsonb_build_object('completed',EXISTS(
	SELECT 1 FROM vaccine_records r WHERE r.family_id=s.family_id AND r.baby_id=s.baby_id
	AND r.vaccine_id=s.vaccine_id AND r.dose_number=s.dose_number AND r.record_status='completed'
	AND r.is_completed AND r.administered_date IS NOT NULL
	AND r.administered_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
	AND r.deleted_at IS NULL))`

func (s *Server) listVaccineSelections(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := medicalScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		rows, err := many(ctx, q, "SELECT "+vaccineSelectionCompletedProjection+" FROM vaccine_selections s WHERE family_id=$1 AND baby_id=$2 ORDER BY vaccine_id,dose_number", scope.FamilyID, scope.BabyID)
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
	if _, supplied := r.Body["completed"]; supplied {
		return Result{}, apiError(400, "READ_ONLY_VACCINE_COMPLETION", "Vaccine completion is derived from records; use vaccine records to change it")
	}
	return s.clinicalTransaction(ctx, r, func(tx pgx.Tx, scope Scope) (Result, bool, error) {
		requested, dose := text(r.Body["vaccineId"]), integer(r.Body["doseNumber"])
		vaccine, err := one(ctx, tx, "SELECT to_jsonb(v) FROM vaccines v WHERE id=$1 OR vaccine_code=$1 ORDER BY (id=$1) DESC LIMIT 1", requested)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, false, notFound("vaccine", requested)
		}
		if err != nil {
			return Result{}, false, err
		}
		existing, err := one(ctx, tx, "SELECT to_jsonb(s) FROM vaccine_selections s WHERE family_id=$1 AND baby_id=$2 AND vaccine_id=$3 AND dose_number=$4 FOR UPDATE", scope.FamilyID, scope.BabyID, vaccine["id"], dose)
		if errors.Is(err, pgx.ErrNoRows) {
			existing, err = nil, nil
		}
		if err != nil {
			return Result{}, false, err
		}
		version, id := int64(1), newID()
		selected := true
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
		now := time.Now().UTC().Truncate(time.Millisecond)
		values := Object{"selected": selected, "version": version, "updated_at": now}
		if existing == nil {
			values["id"], values["family_id"], values["baby_id"], values["vaccine_id"], values["dose_number"], values["created_at"], values["completed"] = id, scope.FamilyID, scope.BabyID, vaccine["id"], dose, now, false
			existing, err = insertObject(ctx, tx, "vaccine_selections", values)
		} else {
			existing, err = updateColumns(ctx, tx, "vaccine_selections", id, values)
		}
		if err != nil {
			return Result{}, false, err
		}
		_, err = one(ctx, tx, `SELECT to_jsonb(r) FROM vaccine_records r WHERE family_id=$1 AND baby_id=$2
			AND vaccine_id=$3 AND dose_number=$4 AND record_status='completed' AND is_completed
			AND administered_date IS NOT NULL AND deleted_at IS NULL ORDER BY administered_date DESC,id LIMIT 1`, scope.FamilyID, scope.BabyID, vaccine["id"], dose)
		if errors.Is(err, pgx.ErrNoRows) {
			existing["completed"] = false
		} else if err != nil {
			return Result{}, false, err
		} else {
			existing["completed"] = true
		}
		result, err := ok(vaccineSelectionDTO(existing))
		return result, true, err
	})
}
