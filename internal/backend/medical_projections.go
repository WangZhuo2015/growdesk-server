package backend

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

func replaceMedicalAttachments(ctx context.Context, tx pgx.Tx, scope Scope, reportID string, value any) error {
	items, ok := value.([]any)
	if !ok { return invalid("attachmentIds must be an array") }
	// The request body is bounded, but duplicate link IDs are an error rather
	// than a silent rewrite of the client's requested attachment sequence.
	ids := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		id, ok := item.(string)
		if !ok { return invalid("attachmentIds must contain strings") }
		if seen[id] { return apiError(409, "CONFLICT", "Duplicate attachment association") }
		seen[id] = true
		ids = append(ids, id)
	}
	old, err := many(ctx, tx, "SELECT jsonb_build_object('id',attachment_id) FROM medical_report_attachments WHERE report_id=$1", reportID)
	if err != nil { return err }
	for _, row := range old { seen[text(row["id"])] = true }
	locks := make([]string, 0, len(seen))
	for id := range seen { locks = append(locks, id) }
	sort.Strings(locks)
	for _, id := range locks {
		var locked string
		err := tx.QueryRow(ctx, "SELECT id FROM attachments WHERE id=$1 FOR UPDATE", id).Scan(&locked)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) { return err }
	}
	for _, id := range ids {
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM attachments WHERE id=$1 AND family_id=$2 AND baby_id=$3
			AND status='ready' AND deleted_at IS NULL AND purpose='medical_report')`, id, scope.FamilyID, scope.BabyID).Scan(&allowed); err != nil { return err }
		if !allowed { return notFound("Attachment", id) }
	}
	if _, err = tx.Exec(ctx, "DELETE FROM medical_report_attachments WHERE report_id=$1", reportID); err != nil { return err }
	for _, id := range ids {
		if _, err = tx.Exec(ctx, "INSERT INTO medical_report_attachments(id,report_id,attachment_id) VALUES($1,$2,$3)", newID(), reportID, id); err != nil { return err }
	}
	return nil
}

func writeMedicalProjection(ctx context.Context, tx pgx.Tx, scope Scope, row Object, create bool, now time.Time) error {
	details, err := jsonText(Object{"hospital": row["hospital"], "department": row["department"], "diagnosis": row["diagnosis"]})
	if err != nil { return err }
	day, err := time.Parse("2006-01-02", text(dateValue(row["report_date"])))
	if err != nil { return err }
	summary := "医疗就诊/检查: " + text(row["title"])
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,created_at,updated_at)
			VALUES($1,$2,$3,'medical',$4,$5,$6,$7::jsonb,'ui_manual',1,$8,$8)`, newID(), scope.FamilyID, scope.BabyID, row["id"], day, summary, details, now)
	} else {
		_, err = tx.Exec(ctx, `UPDATE timeline_entries SET occurred_at=$4,summary=$5,details=$6::jsonb,version=version+1,updated_at=$7
			WHERE family_id=$1 AND baby_id=$2 AND entity_type='medical' AND entity_id=$3`, scope.FamilyID, scope.BabyID, row["id"], day, summary, details, now)
	}
	return err
}

// A medical creation may carry growth observations. These are part of that
// command's transaction, not a second request or a second sync cursor advance.
func insertMedicalGrowth(ctx context.Context, tx pgx.Tx, scope Scope, reportID string, reportDate any, growth Object, now time.Time) error {
	day, err := time.Parse("2006-01-02", text(dateValue(reportDate)))
	if err != nil { return err }
	id := newID()
	values := Object{"id": id, "family_id": scope.FamilyID, "baby_id": scope.BabyID, "measurement_date": day,
		"notes": "Medical report: " + reportID, "version": 1, "created_at": now, "updated_at": now}
	details := Object{"medicalReportId": reportID}
	for _, field := range []struct{ wire, column string }{{"weightKg", "weight_kg"}, {"heightCm", "height_cm"}, {"headCircumferenceCm", "head_circumference_cm"}} {
		if value, supplied := growth[field.wire]; supplied {
			number, err := catalogDecimal(value)
			if err != nil { return err }
			values[field.column] = number
			details[field.wire] = value
		}
	}
	if _, err = insertObject(ctx, tx, "growth_measurements", values); err != nil { return err }
	raw, err := jsonText(details)
	if err != nil { return err }
	_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,created_at,updated_at)
		VALUES($1,$2,$3,'growth',$4,$5,'生长测量',$6::jsonb,'ui_manual',1,$7,$7)`, newID(), scope.FamilyID, scope.BabyID, id, day, raw, now)
	return err
}
