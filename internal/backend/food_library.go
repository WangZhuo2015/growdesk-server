package backend

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// These DTOs deliberately exclude persistence-only fields. A missing status is
// omitted; an explicitly stored false status is not the same as an absent row.
type foodLibraryStatus struct {
	ID             string  `json:"-"`
	CreatedAt      string  `json:"-"`
	UpdatedAt      string  `json:"-"`
	Tried          bool    `json:"tried"`
	Status         string  `json:"status"`
	FirstAddedDate *string `json:"firstAddedDate"`
	Acceptance     int64   `json:"acceptance"`
	Reaction       *string `json:"reaction"`
	Version        int64   `json:"version"`
}

type foodLibraryTexture struct {
	AgeMinMonths *int64 `json:"ageMinMonths"`
	AgeMaxMonths *int64 `json:"ageMaxMonths"`
	Texture      string `json:"texture"`
}

type foodLibraryDataSource struct {
	AsOf             string `json:"asOf"`
	Scope            string `json:"scope"`
	EvidenceConflict bool   `json:"evidenceConflict"`
}

type foodLibraryItem struct {
	ID                               string                 `json:"id"`
	Name                             string                 `json:"name"`
	Icon                             string                 `json:"icon"`
	Category                         string                 `json:"category"`
	FoodGroup                        *string                `json:"foodGroup"`
	Status                           string                 `json:"status"`
	FirstAddedDate                   *string                `json:"firstAddedDate"`
	Acceptance                       int64                  `json:"acceptance"`
	AllergenRisk                     string                 `json:"allergenRisk"`
	RecommendedAgeMonths             int64                  `json:"recommendedAgeMonths"`
	RecommendedFromMonth             *int64                 `json:"recommendedFromMonth"`
	RecommendedToMonth               *int64                 `json:"recommendedToMonth"`
	ExactMonthEvidence               bool                   `json:"exactMonthEvidence"`
	Guidance                         *string                `json:"guidance"`
	IsCommonAllergen                 *bool                  `json:"isCommonAllergen"`
	AllergenIntroductionGuidance     *string                `json:"allergenIntroductionGuidance"`
	HighRiskInfantNeedsMedicalAdvice *bool                  `json:"highRiskInfantNeedsMedicalAdvice"`
	ChokingRisk                      bool                   `json:"chokingRisk"`
	ChokingNotes                     *string                `json:"chokingNotes"`
	Preparation                      []string               `json:"preparation"`
	AvoidBeforeMonths                *int64                 `json:"avoidBeforeMonths"`
	Nutrition                        []string               `json:"nutrition"`
	TextureByAge                     []foodLibraryTexture   `json:"textureByAge"`
	Notes                            *string                `json:"notes"`
	SourceRefs                       []string               `json:"sourceRefs"`
	DataSource                       *foodLibraryDataSource `json:"dataSource,omitempty"`
	NutritionBasis                   any                    `json:"nutritionBasis"`
	NutrientsJson                    any                    `json:"nutrientsJson"`
	Version                          int64                  `json:"version"`
	CreatedAt                        string                 `json:"-"`
	UpdatedAt                        string                 `json:"-"`
	FamilyStatus                     *foodLibraryStatus     `json:"familyStatus,omitempty"`
}

func foodLibraryArray(value any, target any) error {
	if value == nil {
		return nil
	}
	raw, err := jsonBytes(value)
	if err != nil {
		return err
	}
	return decodeJSON(raw, target)
}

func foodLibraryNullableText(value any) *string {
	if value == nil {
		return nil
	}
	result := text(value)
	return &result
}

func foodLibraryNullableInt(value any) *int64 {
	if value == nil {
		return nil
	}
	result := integer(value)
	return &result
}

func foodLibraryNullableBool(value any) *bool {
	if value == nil {
		return nil
	}
	result := boolean(value)
	return &result
}

func foodLibraryItemFromRows(item, status Object) (foodLibraryItem, error) {
	value := foodLibraryItem{
		ID: text(item["id"]), Name: text(item["name"]), Icon: text(item["icon"]),
		Category: text(item["category"]), FoodGroup: foodLibraryNullableText(item["food_group"]),
		Status: "to_try", Acceptance: 0,
		AllergenRisk: text(item["allergen_risk"]), RecommendedAgeMonths: integer(item["recommended_age_months"]),
		RecommendedFromMonth:             foodLibraryNullableInt(item["recommended_from_month"]),
		RecommendedToMonth:               foodLibraryNullableInt(item["recommended_to_month"]),
		ExactMonthEvidence:               boolean(item["exact_month_evidence"]),
		Guidance:                         foodLibraryNullableText(item["guidance"]),
		IsCommonAllergen:                 foodLibraryNullableBool(item["is_common_allergen"]),
		AllergenIntroductionGuidance:     foodLibraryNullableText(item["allergen_introduction_guidance"]),
		HighRiskInfantNeedsMedicalAdvice: foodLibraryNullableBool(item["high_risk_infant_needs_medical_advice"]),
		ChokingRisk:                      boolean(item["choking_risk"]), ChokingNotes: foodLibraryNullableText(item["choking_notes"]),
		AvoidBeforeMonths: foodLibraryNullableInt(item["avoid_before_months"]),
		Notes:             foodLibraryNullableText(item["notes"]),
		NutrientsJson:     item["nutrients_json"], Version: integer(item["version"]),
		CreatedAt: text(isoValue(item["created_at"])), UpdatedAt: text(isoValue(item["updated_at"])),
	}
	if err := foodLibraryArray(item["preparation_json"], &value.Preparation); err != nil {
		return foodLibraryItem{}, err
	}
	if value.Preparation == nil {
		value.Preparation = []string{}
	}
	if err := foodLibraryArray(item["nutrition_highlights_json"], &value.Nutrition); err != nil {
		return foodLibraryItem{}, err
	}
	if value.Nutrition == nil {
		value.Nutrition = []string{}
	}
	if err := foodLibraryArray(item["texture_by_age_json"], &value.TextureByAge); err != nil {
		return foodLibraryItem{}, err
	}
	if value.TextureByAge == nil {
		value.TextureByAge = []foodLibraryTexture{}
	}
	if err := foodLibraryArray(item["source_refs_json"], &value.SourceRefs); err != nil {
		return foodLibraryItem{}, err
	}
	if value.SourceRefs == nil {
		value.SourceRefs = []string{}
	}
	if item["data_source_as_of"] != nil {
		value.DataSource = &foodLibraryDataSource{
			AsOf: text(item["data_source_as_of"]), Scope: text(item["data_source_scope"]),
			EvidenceConflict: boolean(item["data_source_evidence_conflict"]),
		}
	}
	if value.NutrientsJson != nil {
		value.NutritionBasis = "per_100g"
	}
	if status != nil {
		value.FirstAddedDate = foodLibraryNullableText(status["first_added_date"])
		value.Acceptance = integer(status["acceptance"])
		tried := boolean(status["tried"])
		value.Status = "to_try"
		if tried {
			value.Status = "tried"
		}
		value.FamilyStatus = &foodLibraryStatus{
			ID: text(status["id"]), Tried: tried, Status: value.Status,
			CreatedAt: text(isoValue(status["created_at"])), UpdatedAt: text(isoValue(status["updated_at"])),
			FirstAddedDate: foodLibraryNullableText(status["first_added_date"]),
			Acceptance:     integer(status["acceptance"]), Reaction: foodLibraryNullableText(status["reaction"]),
			Version: integer(status["version"]),
		}
	}
	return value, nil
}

func selectFoodLibraryFamily(requested string, active []string) (string, error) {
	if requested != "" {
		for _, id := range active {
			if id == requested {
				return id, nil
			}
		}
		return "", apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+requested)
	}
	if len(active) == 1 {
		return active[0], nil
	}
	if len(active) == 0 {
		return "", apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: none")
	}
	return "", apiError(400, "FAMILY_SELECTION_REQUIRED", "A familyId is required when the account has multiple active families")
}

func foodLibraryFamily(ctx context.Context, q Querier, userID, requested string) (string, error) {
	if requested != "" {
		if _, err := familyRole(ctx, q, userID, requested); err != nil {
			return "", err
		}
		return requested, nil
	}
	// Two rows are sufficient to distinguish none, one, and an ambiguous scope.
	rows, err := q.Query(ctx, `SELECT fm.family_id FROM family_members fm
		JOIN families f ON f.id=fm.family_id AND f.deleted_at IS NULL
		JOIN users u ON u.id=fm.user_id AND u.deleted_at IS NULL
		WHERE fm.user_id=$1 AND fm.status='active' AND fm.deleted_at IS NULL
		ORDER BY fm.family_id LIMIT 2`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	active := make([]string, 0, 2)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		active = append(active, id)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return selectFoodLibraryFamily("", active)
}

func (s *Server) registerFoodLibrary() {
	s.Register("listFoodLibraryItems", false, foodLibraryErrorBoundary(s.listFoodLibraryItems))
	s.Register("createFoodLibraryItem", false, foodLibraryErrorBoundary(s.createFoodLibraryItem))
	s.Register("updateFoodLibraryItem", false, foodLibraryErrorBoundary(s.updateFoodLibraryItem))
	s.Register("updateFamilyFoodStatus", false, foodLibraryErrorBoundary(s.updateFamilyFoodStatus))
	s.Register("getFoodGuidelines", false, func(_ context.Context, _ *Request) (Result, error) {
		return ok(foodGuidelines())
	})
}

func (s *Server) listFoodLibraryItems(ctx context.Context, r *Request) (Result, error) {
	familyID, err := foodLibraryFamily(ctx, s.DB, r.Principal.UserID, r.HTTP.URL.Query().Get("familyId"))
	if err != nil {
		return Result{}, err
	}
	// The outer membership row distinguishes revoked access from an empty
	// catalog. Authorization and data use the same PostgreSQL statement snapshot.
	// The status JOIN is scoped independently of public/custom item visibility.
	var raw []byte
	err = s.DB.QueryRow(ctx, `SELECT COALESCE((
		SELECT jsonb_agg(jsonb_build_object('item',to_jsonb(i),'status',to_jsonb(fs))
			ORDER BY i.recommended_from_month ASC NULLS FIRST,
			CASE WHEN i.is_custom THEN 2147483647 ELSE COALESCE(i.catalog_order,2147483646) END,
			i.name ASC,i.id ASC)
		FROM food_library_items i
		LEFT JOIN family_food_statuses fs ON fs.food_item_id=i.id AND fs.family_id=$1
		WHERE i.is_custom=false OR (i.is_custom=true AND i.family_id=$1)
	), '[]'::jsonb)
	FROM family_members fm
	JOIN families f ON f.id=fm.family_id AND f.deleted_at IS NULL
	JOIN users u ON u.id=fm.user_id AND u.deleted_at IS NULL
	WHERE fm.family_id=$1 AND fm.user_id=$2 AND fm.status='active' AND fm.deleted_at IS NULL`,
		familyID, r.Principal.UserID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+familyID)
	}
	if err != nil {
		return Result{}, err
	}
	rows := make([]Object, 0)
	if err := decodeJSON(raw, &rows); err != nil {
		return Result{}, err
	}
	items := make([]foodLibraryItem, 0, len(rows))
	for _, row := range rows {
		item, err := foodLibraryItemFromRows(obj(row["item"]), obj(row["status"]))
		if err != nil {
			return Result{}, err
		}
		items = append(items, item)
	}
	return ok(items)
}

func (s *Server) createFoodLibraryItem(ctx context.Context, r *Request) (Result, error) {
	familyID, err := foodLibraryFamily(ctx, s.DB, r.Principal.UserID, text(r.Body["familyId"]))
	if err != nil {
		return Result{}, err
	}
	key, err := nativeExportIdempotencyKey(r.HTTP.Header.Values("Idempotency-Key"))
	if err != nil {
		return Result{}, err
	}
	requestHash := ""
	commandID := ""
	if key != "" {
		requestHash, err = snapshotHash(Object{"operation": "create_food_library_item", "body": r.Body})
		if err != nil {
			return Result{}, err
		}
		commandID = "food_item:create:" + key
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, familyID)
	if err != nil {
		return Result{}, err
	}
	role, err := familyRole(ctx, tx, r.Principal.UserID, familyID)
	if err != nil {
		return Result{}, err
	}
	if role == "viewer" {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+familyID)
	}
	if key != "" {
		receipt, lookupErr := one(ctx, tx, `SELECT to_jsonb(i) FROM idempotency_receipts i
			WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`, r.Principal.UserID, familyID, commandID)
		if lookupErr == nil {
			if text(receipt["request_hash"]) != requestHash {
				return Result{}, reusedKey(key)
			}
			response := obj(receipt["response_body"])
			if integer(receipt["result_code"]) != http.StatusCreated || response == nil {
				return Result{}, apiError(500, "FOOD_ITEM_RECEIPT_INVALID", "Stored food item receipt is invalid")
			}
			if err = tx.Commit(ctx); err != nil {
				return Result{}, err
			}
			return Result{Status: http.StatusCreated, Body: response}, nil
		}
		if !errors.Is(lookupErr, pgx.ErrNoRows) {
			return Result{}, lookupErr
		}
	}
	if cursor >= math.MaxInt64-1 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted")
	}
	statusValue := text(r.Body["status"])
	triedValue, hasTried := r.Body["tried"]
	if statusValue == "" && hasTried {
		if boolean(triedValue) {
			statusValue = "tried"
		} else {
			statusValue = "to_try"
		}
	}
	if statusValue != "" && hasTried && boolean(triedValue) != (statusValue == "tried") {
		return Result{}, invalid("status and tried must describe the same family food state")
	}
	_, hasFirstAddedDate := r.Body["firstAddedDate"]
	_, hasAcceptance := r.Body["acceptance"]
	hasStatus := statusValue != "" || hasFirstAddedDate || hasAcceptance
	if statusValue == "" {
		statusValue = "to_try"
	}
	tried := statusValue == "tried"
	if statusValue != "tried" && statusValue != "to_try" {
		return Result{}, invalid("status must be tried or to_try")
	}
	item := foodLibraryItem{
		ID: "custom_" + newID(), Name: text(r.Body["name"]), Icon: text(r.Body["icon"]),
		Category: text(r.Body["category"]), Status: "to_try", Acceptance: 0,
		AllergenRisk: text(r.Body["allergenRisk"]), RecommendedAgeMonths: integer(r.Body["recommendedAgeMonths"]),
		Preparation: []string{}, Nutrition: []string{}, TextureByAge: []foodLibraryTexture{}, SourceRefs: []string{}, Version: 1,
	}
	if item.Icon == "" {
		item.Icon = "🍽️"
	}
	if item.Category == "" {
		item.Category = "other"
	}
	if item.AllergenRisk == "" {
		item.AllergenRisk = "low"
	}
	item.NutrientsJson, err = nutritionProfileJSON(r.Body["nutrientsJson"])
	if err != nil {
		return Result{}, err
	}
	if basis := r.Body["nutritionBasis"]; basis != nil && text(basis) != "per_100g" {
		return Result{}, invalid("nutritionBasis must be per_100g")
	}
	if item.NutrientsJson != nil {
		item.NutritionBasis = "per_100g"
	} else if r.Body["nutritionBasis"] != nil {
		return Result{}, invalid("nutritionBasis requires nutrientsJson")
	}
	_, err = tx.Exec(ctx, `INSERT INTO food_library_items
		(id,name,icon,category,allergen_risk,recommended_age_months,is_custom,family_id,nutrients_json,version,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,1,NOW(),NOW())`, item.ID, item.Name, item.Icon, item.Category,
		item.AllergenRisk, item.RecommendedAgeMonths, familyID, item.NutrientsJson)
	if err != nil {
		return Result{}, err
	}
	if hasStatus {
		addedDate := r.Body["firstAddedDate"]
		if _, present := r.Body["firstAddedDate"]; !present {
			addedDate = nil
		}
		acceptance := integer(r.Body["acceptance"])
		_, err = tx.Exec(ctx, `INSERT INTO family_food_statuses
			(id,family_id,food_item_id,tried,reaction,first_added_date,acceptance,version,created_at,updated_at)
			VALUES($1,$2,$3,$4,NULL,$5,$6,1,NOW(),NOW())`, newID(), familyID, item.ID, tried, addedDate, acceptance)
		if err != nil {
			return Result{}, err
		}
	}
	loaded, err := loadFoodLibraryItem(ctx, tx, familyID, item.ID)
	if err != nil {
		return Result{}, err
	}
	item = loaded
	if err = appendFoodLibraryChange(ctx, tx, familyID, cursor+1, "food_item", item.ID, item.Version, foodLibraryItemChangePayload(item, familyID)); err != nil {
		return Result{}, err
	}
	if hasStatus {
		status := item.FamilyStatus
		if status == nil {
			return Result{}, errors.New("created family food status is missing")
		}
		if err = appendFoodLibraryChange(ctx, tx, familyID, cursor+2, "food_status", status.ID, status.Version, foodLibraryStatusChangePayload(familyID, item.ID, *status)); err != nil {
			return Result{}, err
		}
	}
	if err = setFoodLibraryCursor(ctx, tx, familyID, cursor+1); err != nil {
		return Result{}, err
	}
	if hasStatus {
		if err = setFoodLibraryCursor(ctx, tx, familyID, cursor+2); err != nil {
			return Result{}, err
		}
	}
	if key != "" {
		body, marshalErr := jsonText(item)
		if marshalErr != nil {
			return Result{}, marshalErr
		}
		if _, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,response_body,completed_at)
			VALUES($1,$2,$3,$4,$5,$6::jsonb,NOW())`, r.Principal.UserID, familyID, commandID, requestHash, http.StatusCreated, body); err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusCreated, Body: item}, nil
}

func loadFoodLibraryItem(ctx context.Context, q Querier, familyID, itemID string) (foodLibraryItem, error) {
	row, err := one(ctx, q, `SELECT jsonb_build_object('item',to_jsonb(i),'status',to_jsonb(fs))
		FROM food_library_items i LEFT JOIN family_food_statuses fs ON fs.family_id=$1 AND fs.food_item_id=i.id
		WHERE i.id=$2 AND (i.is_custom=false OR i.family_id=$1)`, familyID, itemID)
	if err != nil {
		return foodLibraryItem{}, err
	}
	return foodLibraryItemFromRows(obj(row["item"]), obj(row["status"]))
}

func setFoodLibraryCursor(ctx context.Context, tx pgx.Tx, familyID string, cursor int64) error {
	_, err := tx.Exec(ctx, `UPDATE family_sync_states SET cursor=$2,updated_at=NOW() WHERE family_id=$1`, familyID, cursor)
	return err
}

func appendFoodLibraryChange(ctx context.Context, tx pgx.Tx, familyID string, cursor int64, entityType, entityID string, version int64, payload Object) error {
	encoded, err := jsonText(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO family_changes(family_id,cursor,entity_type,entity_id,version,op,payload,schema_version,created_at)
		VALUES($1,$2,$3,$4,$5,'upsert',$6::jsonb,1,NOW())`, familyID, cursor, entityType, entityID, version, encoded)
	return err
}

func foodLibraryItemChangePayload(item foodLibraryItem, familyID string) Object {
	payload := Object{
		"id": item.ID, "familyId": familyID, "name": item.Name, "icon": item.Icon, "category": item.Category,
		"foodGroup": item.FoodGroup, "allergenRisk": item.AllergenRisk,
		"recommendedAgeMonths": item.RecommendedAgeMonths, "recommendedFromMonth": item.RecommendedFromMonth,
		"recommendedToMonth": item.RecommendedToMonth, "exactMonthEvidence": item.ExactMonthEvidence,
		"guidance": item.Guidance, "isCommonAllergen": item.IsCommonAllergen,
		"allergenIntroductionGuidance":     item.AllergenIntroductionGuidance,
		"highRiskInfantNeedsMedicalAdvice": item.HighRiskInfantNeedsMedicalAdvice,
		"chokingRisk":                      item.ChokingRisk, "chokingNotes": item.ChokingNotes,
		"preparation": item.Preparation, "avoidBeforeMonths": item.AvoidBeforeMonths,
		"nutrition": item.Nutrition, "textureByAge": item.TextureByAge, "notes": item.Notes,
		"sourceRefs": item.SourceRefs, "version": strconv.FormatInt(item.Version, 10), "isCustom": true,
		"createdAt": item.CreatedAt, "updatedAt": item.UpdatedAt,
		"nutritionBasis": item.NutritionBasis, "nutrientsJson": item.NutrientsJson,
	}
	if item.DataSource != nil {
		payload["dataSource"] = item.DataSource
	}
	return payload
}

func foodLibraryStatusChangePayload(familyID, itemID string, status foodLibraryStatus) Object {
	return Object{
		"id": status.ID, "familyId": familyID, "foodItemId": itemID,
		"tried": status.Tried, "status": status.Status, "firstAddedDate": status.FirstAddedDate,
		"acceptance": status.Acceptance, "reaction": status.Reaction, "version": strconv.FormatInt(status.Version, 10),
		"createdAt": status.CreatedAt, "updatedAt": status.UpdatedAt,
	}
}

func (s *Server) updateFamilyFoodStatus(ctx context.Context, r *Request) (Result, error) {
	familyID, foodID := r.Params["familyId"], r.Params["foodId"]
	if _, err := familyRole(ctx, s.DB, r.Principal.UserID, familyID); err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, familyID)
	if err != nil {
		return Result{}, err
	}
	role, err := familyRole(ctx, tx, r.Principal.UserID, familyID)
	if err != nil {
		return Result{}, err
	}
	if role == "viewer" {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Family write access denied")
	}
	if cursor == math.MaxInt64 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted")
	}
	if _, err = one(ctx, tx, `SELECT to_jsonb(i) FROM food_library_items i
		WHERE i.id=$1 AND (i.is_custom=false OR i.family_id=$2) FOR SHARE`, foodID, familyID); errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("food_library_item", foodID)
	} else if err != nil {
		return Result{}, err
	}
	current, err := one(ctx, tx, `SELECT to_jsonb(fs) FROM family_food_statuses fs WHERE family_id=$1 AND food_item_id=$2 FOR UPDATE`, familyID, foodID)
	if errors.Is(err, pgx.ErrNoRows) {
		if integer(r.Body["baseVersion"]) != 0 {
			return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food status changed; reload before saving")
		}
	} else if err != nil {
		return Result{}, err
	} else if integer(current["version"]) != integer(r.Body["baseVersion"]) {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food status changed; reload before saving")
	}
	version := int64(1)
	if current != nil {
		version = integer(current["version"]) + 1
		if version >= math.MaxInt32 {
			return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food status version range exhausted")
		}
	}
	statusText := text(r.Body["status"])
	tried := statusText == "tried"
	reaction := any(nil)
	if current != nil {
		reaction = current["reaction"]
	}
	if supplied, ok := r.Body["reaction"]; ok {
		reaction = supplied
	}
	addedDate := r.Body["firstAddedDate"]
	statusID := text(current["id"])
	if statusID == "" {
		statusID = newID()
	}
	acceptance := integer(r.Body["acceptance"])
	if current == nil {
		_, err = tx.Exec(ctx, `INSERT INTO family_food_statuses
			(id,family_id,food_item_id,tried,reaction,first_added_date,acceptance,version,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`, statusID, familyID, foodID, tried, reaction, addedDate, acceptance, version)
	} else {
		_, err = tx.Exec(ctx, `UPDATE family_food_statuses SET tried=$4,reaction=$5,first_added_date=$6,
			acceptance=$7,version=$8,updated_at=NOW() WHERE family_id=$1 AND food_item_id=$2 AND id=$3`,
			familyID, foodID, statusID, tried, reaction, addedDate, acceptance, version)
	}
	if err != nil {
		return Result{}, err
	}
	row, err := one(ctx, tx, `SELECT to_jsonb(fs) FROM family_food_statuses fs WHERE family_id=$1 AND food_item_id=$2`, familyID, foodID)
	if err != nil {
		return Result{}, err
	}
	status := foodLibraryStatus{
		ID: text(row["id"]), Tried: boolean(row["tried"]), FirstAddedDate: foodLibraryNullableText(row["first_added_date"]),
		Acceptance: integer(row["acceptance"]), Reaction: foodLibraryNullableText(row["reaction"]), Version: integer(row["version"]),
		CreatedAt: text(isoValue(row["created_at"])), UpdatedAt: text(isoValue(row["updated_at"])),
	}
	status.Status = "to_try"
	if status.Tried {
		status.Status = "tried"
	}
	if err = setFoodLibraryCursor(ctx, tx, familyID, cursor+1); err != nil {
		return Result{}, err
	}
	if err = appendFoodLibraryChange(ctx, tx, familyID, cursor+1, "food_status", status.ID, status.Version,
		foodLibraryStatusChangePayload(familyID, foodID, status)); err != nil {
		return Result{}, err
	}
	response := Object{
		"id": status.ID, "familyId": familyID, "foodId": foodID,
		"tried": status.Tried, "status": status.Status, "firstAddedDate": status.FirstAddedDate,
		"acceptance": status.Acceptance, "reaction": status.Reaction, "version": status.Version,
		"updatedAt": isoValue(row["updated_at"]),
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(response)
}

func (s *Server) updateFoodLibraryItem(ctx context.Context, r *Request) (Result, error) {
	familyID, id := r.Params["familyId"], r.Params["id"]
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, familyID)
	if err != nil {
		return Result{}, err
	}
	role, err := familyRole(ctx, tx, r.Principal.UserID, familyID)
	if err != nil {
		return Result{}, err
	}
	if role == "viewer" {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Family write access denied")
	}
	current, err := one(ctx, tx, `SELECT to_jsonb(i) FROM food_library_items i
		WHERE i.id=$1 AND i.family_id=$2 AND i.is_custom=true FOR UPDATE`, id, familyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("food_library_item", id)
	}
	if err != nil {
		return Result{}, err
	}
	version := integer(current["version"])
	if version < 1 || version >= math.MaxInt32 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food item version range exhausted")
	}
	if integer(r.Body["baseVersion"]) != version {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Food item changed; reload before saving")
	}
	profile, err := nutritionProfileJSON(r.Body["nutrientsJson"])
	if err != nil {
		return Result{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = updateColumns(ctx, tx, "food_library_items", id, Object{
		"nutrients_json": profile, "version": version + 1, "updated_at": now,
	})
	if err != nil {
		return Result{}, err
	}
	if cursor == math.MaxInt64 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted")
	}
	updated, err := loadFoodLibraryItem(ctx, tx, familyID, id)
	if err != nil {
		return Result{}, err
	}
	if err = setFoodLibraryCursor(ctx, tx, familyID, cursor+1); err != nil {
		return Result{}, err
	}
	if err = appendFoodLibraryChange(ctx, tx, familyID, cursor+1, "food_item", id, updated.Version, foodLibraryItemChangePayload(updated, familyID)); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusOK, Body: updated}, nil
}

type foodGuideline struct {
	MonthAge       int      `json:"monthAge"`
	Title          string   `json:"title"`
	Content        string   `json:"content"`
	ForbiddenFoods []string `json:"forbiddenFoods"`
}

// Exact reference dataset, not newly generated medical advice. Fresh slices
// prevent handlers or tests from mutating shared process-wide catalog state.
func foodGuidelines() []foodGuideline {
	return []foodGuideline{
		{6, "Stage 1: Introduction to Solids (6 Months)",
			"Begin with smooth, iron-fortified single-ingredient purees (iron cereal, pumpkin, sweet potato, avocado, apple). Introduce one new food every 3-5 days to observe tolerance.",
			[]string{"honey", "cow_milk", "added_salt", "added_sugar", "whole_nuts"}},
		{8, "Stage 2: Thicker Purees & Soft Mashed (7-9 Months)",
			"Progress from fine purees to lumpy mashes and soft finger foods. Introduce proteins (chicken, pork, egg yolk, tofu, white fish) and various fruits and vegetables.",
			[]string{"honey", "raw_eggs", "whole_grapes", "hard_candies", "added_salt"}},
		{10, "Stage 3: Chopped Table Foods (10-12 Months)",
			"Transition towards bite-sized soft cooked family foods (diced vegetables, meatballs, pasta, whole egg). Foster self-feeding with spoon and fingers.",
			[]string{"honey", "high_sodium_processed_food", "unpasteurized_dairy"}},
		{12, "Stage 4: Family Table Foods (12+ Months)",
			"Join standard family meal patterns with low sodium and gentle seasoning. Pasteurized whole cow milk can replace formula as primary beverage.",
			[]string{"unpasteurized_dairy", "choking_hazards_without_supervision"}},
	}
}
