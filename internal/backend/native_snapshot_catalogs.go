package backend

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// A snapshot/export contains the complete supported application state for the
// caller's currently visible babies, not arbitrary persistence columns.
func appendNativeSnapshotAuxiliary(ctx context.Context, q Querier, input nativeTaskInput, babies []string, out *nativeSnapshotContent) error {
	specs := []struct {
		kind, table, where string
		columns            [][2]string
	}{
		{"family", "families", "id=$1 AND deleted_at IS NULL", [][2]string{{"id", "id"}, {"name", "name"}, {"timeZone", "timezone"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"family_member", "family_members", "family_id=$1 AND deleted_at IS NULL AND status='active'", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"userId", "user_id"}, {"role", "role"}, {"relation", "relation"}, {"status", "status"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"baby_member", "baby_members", "family_id=$1 AND baby_id=ANY($2::text[]) AND deleted_at IS NULL AND status='active'", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"userId", "user_id"}, {"role", "role"}, {"status", "status"}, {"version", "version"}}},
		{"food_plan", "baby_food_plans", "family_id=$1 AND baby_id=ANY($2::text[])", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"planData", "plan_data"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"supplement_schedule", "supplement_schedules", "family_id=$1 AND baby_id=ANY($2::text[]) AND deleted_at IS NULL", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"productId", "product_id"}, {"frequency", "frequency"}, {"customDays", "custom_days_json"}, {"targetDose", "target_dose"}, {"reminderTime", "reminder_time"}, {"isActive", "is_active"}, {"startDate", "start_date"}, {"notes", "notes"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"vaccine_selection", "vaccine_selections", "family_id=$1 AND baby_id=ANY($2::text[]) ", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"vaccineId", "vaccine_id"}, {"doseNumber", "dose_number"}, {"selected", "selected"}, {"completed", "completed"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"food_status", "family_food_statuses", "family_id=$1", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"foodItemId", "food_item_id"}, {"tried", "tried"}, {"reaction", "reaction"}, {"firstAddedDate", "first_added_date"}, {"acceptance", "acceptance"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"food_item", "food_library_items", "family_id=$1 AND is_custom=true", [][2]string{
			{"id", "id"}, {"familyId", "family_id"}, {"name", "name"}, {"icon", "icon"}, {"category", "category"},
			{"foodGroup", "food_group"}, {"allergenRisk", "allergen_risk"}, {"recommendedAgeMonths", "recommended_age_months"},
			{"recommendedFromMonth", "recommended_from_month"}, {"recommendedToMonth", "recommended_to_month"},
			{"exactMonthEvidence", "exact_month_evidence"}, {"guidance", "guidance"}, {"isCommonAllergen", "is_common_allergen"},
			{"allergenIntroductionGuidance", "allergen_introduction_guidance"}, {"highRiskInfantNeedsMedicalAdvice", "high_risk_infant_needs_medical_advice"},
			{"chokingRisk", "choking_risk"}, {"chokingNotes", "choking_notes"}, {"preparation", "preparation_json"},
			{"avoidBeforeMonths", "avoid_before_months"}, {"nutrition", "nutrition_highlights_json"},
			{"textureByAge", "texture_by_age_json"}, {"notes", "notes"}, {"sourceRefs", "source_refs_json"},
			{"nutrientsJson", "nutrients_json"},
			{"version", "version"}, {"isCustom", "is_custom"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"},
		}},
		{"book_status", "family_book_statuses", "family_id=$1", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"bookId", "book_id"}, {"status", "status"}, {"isFavorite", "is_favorite"}, {"readCount", "read_count"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"daily_summary", "daily_summaries", "family_id=$1 AND baby_id=ANY($2::text[])", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"targetDate", "target_date"}, {"content", "content"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"timeline", "timeline_entries", "family_id=$1 AND baby_id=ANY($2::text[]) AND deleted_at IS NULL", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"entityType", "entity_type"}, {"entityId", "entity_id"}, {"occurredAt", "occurred_at"}, {"summary", "summary"}, {"details", "details"}, {"version", "version"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
		{"attachment", "attachments", "family_id=$1 AND (baby_id IS NULL OR baby_id=ANY($2::text[])) AND status='ready' AND deleted_at IS NULL", [][2]string{{"id", "id"}, {"familyId", "family_id"}, {"babyId", "baby_id"}, {"purpose", "purpose"}, {"mimeType", "mime_type"}, {"byteSize", "byte_size"}, {"sha256", "sha256"}, {"status", "status"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}}},
	}
	totalCount, totalBytes := 0, 0
	add := func(page nativeSnapshotPage) error {
		raw, e := jsonBytes(page)
		if e != nil {
			return e
		}
		totalCount += len(page.Data)
		totalBytes += len(raw)
		if totalCount > 20000 || totalBytes > 12*1024*1024 {
			return apiError(413, "SNAPSHOT_TOO_LARGE", "Snapshot exceeds cumulative budget")
		}
		return nil
	}
	for _, page := range out.Pages {
		if err := add(page); err != nil {
			return err
		}
	}
	for _, spec := range specs {
		last := ""
		for {
			// Every identifier/expression is a source literal in this allowlist.
			// $2 is always bound, even when a shared table has no baby column.
			query := "SELECT to_jsonb(t) FROM " + pgx.Identifier{spec.table}.Sanitize() + " t WHERE " + spec.where +
				" AND $2::text[] IS NOT NULL AND id>$3 ORDER BY id LIMIT 20"
			rows, err := many(ctx, q, query, input.FamilyID, babies, last)
			if err != nil {
				return fmt.Errorf("snapshot %s: %w", spec.kind, err)
			}
			if len(rows) == 0 {
				break
			}
			page := nativeSnapshotPage{EntityType: spec.kind, Data: make([]Object, 0, len(rows))}
			for _, row := range rows {
				value := Object{}
				for _, column := range spec.columns {
					item := row[column[1]]
					switch column[0] {
					case "createdAt", "updatedAt", "occurredAt":
						item = isoValue(item)
					case "startDate", "targetDate", "firstAddedDate":
						item = dateValue(item)
					case "targetDose":
						item = decimalValue(item)
					case "version":
						item = text(item)
					}
					value[column[0]] = item
				}
				if spec.kind == "food_item" {
					if row["nutrients_json"] != nil {
						value["nutritionBasis"] = "per_100g"
					} else {
						value["nutritionBasis"] = nil
					}
				}
				if spec.kind == "food_status" {
					if boolean(row["tried"]) {
						value["status"] = "tried"
					} else {
						value["status"] = "to_try"
					}
				}
				page.Data = append(page.Data, value)
				last = text(row["id"])
			}
			if err = add(page); err != nil {
				return err
			}
			out.Pages = append(out.Pages, page)
		}
	}
	return nil
}
