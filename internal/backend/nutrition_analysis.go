package backend

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed nutrition_reference_legacy_v1.json
var nutritionReferenceFS embed.FS

const nutritionReferenceFile = "nutrition_reference_legacy_v1.json"
const nutritionReferenceVersion = "legacy-growdesk-nutrition-v1"

var nutritionReferenceBytes []byte
var nutritionReferenceHash string
var nutritionReference Object

func init() {
	var err error
	nutritionReferenceBytes, err = nutritionReferenceFS.ReadFile(nutritionReferenceFile)
	if err != nil {
		panic("nutrition reference dataset is missing")
	}
	digest := sha256.Sum256(nutritionReferenceBytes)
	nutritionReferenceHash = hex.EncodeToString(digest[:])
	if err = decodeJSON(nutritionReferenceBytes, &nutritionReference); err != nil {
		panic("nutrition reference dataset is invalid")
	}
}

type nutritionInputs struct {
	familyID     string
	babyID       string
	birthDate    string
	timeZone     string
	feedings     []Object
	supps        []Object
	foods        []Object
	formulas     []Object
	products     []Object
	foodNames    map[string]string
	foodProfiles map[string]any
	foodPlan     Object
}

type nutritionDateRange struct {
	from  time.Time
	to    time.Time
	dates []string
	start time.Time
	end   time.Time
	loc   *time.Location
}

func (s *Server) registerNutritionAnalysis() {
	s.registerDeclared(http.MethodGet, "/api/v1/babies/{babyId}/nutrition/analysis", s.getNutritionAnalysis)
	s.registerDeclared(http.MethodGet, "/api/v1/babies/{babyId}/nutrition/trends", s.getNutritionTrends)
}

func (s *Server) getNutritionAnalysis(ctx context.Context, r *Request) (Result, error) {
	date := r.HTTP.URL.Query().Get("date")
	day, err := parseNutritionDate(date)
	if err != nil {
		return Result{}, err
	}
	version, err := requireNutritionDatasetVersion(r)
	if err != nil {
		return Result{}, err
	}
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		inputs, dateRange, err := loadNutritionInputs(ctx, q, scope.FamilyID, scope.BabyID, day, day)
		if err != nil {
			return Result{}, err
		}
		return ok(buildNutritionDay(inputs, date, dateRange, version))
	})
}

func (s *Server) getNutritionTrends(ctx context.Context, r *Request) (Result, error) {
	from, err := parseNutritionDate(r.HTTP.URL.Query().Get("from"))
	if err != nil {
		return Result{}, err
	}
	to, err := parseNutritionDate(r.HTTP.URL.Query().Get("to"))
	if err != nil {
		return Result{}, err
	}
	if to.Before(from) {
		return Result{}, invalid("to must be on or after from")
	}
	version, err := requireNutritionDatasetVersion(r)
	if err != nil {
		return Result{}, err
	}
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		inputs, dateRange, err := loadNutritionInputs(ctx, q, scope.FamilyID, scope.BabyID, from, to)
		if err != nil {
			return Result{}, err
		}
		daily := make([]Object, 0, len(dateRange.dates))
		for _, date := range dateRange.dates {
			daily = append(daily, buildNutritionDay(inputs, date, dateRange, version))
		}
		data := Object{
			"babyId": inputs.babyID, "familyId": inputs.familyID,
			"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"),
			"daysCount": len(daily), "timeZone": inputs.timeZone,
			"referenceDataset": nutritionReferenceDTO(),
			"daily":            daily,
			"averages":         nutritionTrendAverages(daily),
			"coverage": Object{
				"logCompleteness": "unverified",
				"notes":           []string{"Daily averages include every requested local calendar day, including days with no records.", "The server can summarize recorded rows but cannot verify that caregivers logged every intake."},
			},
		}
		return ok(data)
	})
}

func requireNutritionDatasetVersion(r *Request) (string, error) {
	requested := r.HTTP.URL.Query().Get("datasetVersion")
	if requested != "" && requested != nutritionReferenceVersion {
		return "", apiError(http.StatusConflict, "NUTRITION_DATASET_VERSION_UNSUPPORTED", "Requested nutrition reference dataset version is not available")
	}
	return nutritionReferenceVersion, nil
}

func parseNutritionDate(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, invalid("A YYYY-MM-DD nutrition date is required")
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return time.Time{}, invalid("Nutrition dates must be valid YYYY-MM-DD calendar dates")
	}
	return parsed, nil
}

func makeNutritionDateRange(from, to time.Time, zone string) (nutritionDateRange, error) {
	if zone == "" {
		zone = "UTC"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nutritionDateRange{}, apiError(http.StatusInternalServerError, "INVALID_TIMEZONE", "Family timezone is invalid")
	}
	localFrom := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc)
	localTo := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc)
	end := localTo.AddDate(0, 0, 1)
	dates := make([]string, 0, 90)
	for cursor := localFrom; !cursor.After(localTo); cursor = cursor.AddDate(0, 0, 1) {
		dates = append(dates, cursor.Format("2006-01-02"))
		if len(dates) > 90 {
			return nutritionDateRange{}, invalid("nutrition trends are limited to 90 local calendar days")
		}
	}
	return nutritionDateRange{from: localFrom, to: localTo, dates: dates, start: localFrom.UTC(), end: end.UTC(), loc: loc}, nil
}

func loadNutritionInputs(ctx context.Context, q Querier, familyID, babyID string, from, to time.Time) (nutritionInputs, nutritionDateRange, error) {
	meta, err := one(ctx, q, `SELECT jsonb_build_object('birthDate',b.birth_date::text,'timeZone',f.timezone)
		FROM babies b JOIN families f ON f.id=b.family_id AND f.deleted_at IS NULL
		WHERE b.id=$1 AND b.family_id=$2 AND b.deleted_at IS NULL`, babyID, familyID)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	zone := text(meta["timeZone"])
	_, err = time.LoadLocation(zone)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, apiError(http.StatusInternalServerError, "INVALID_TIMEZONE", "Family timezone is invalid")
	}
	dateRange, err := makeNutritionDateRange(from, to, zone)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, err
	}
	feedings, err := many(ctx, q, `SELECT to_jsonb(r) FROM feeding_records r
		WHERE r.family_id=$1 AND r.baby_id=$2 AND r.deleted_at IS NULL AND r.occurred_at >= $3 AND r.occurred_at < $4
		ORDER BY r.occurred_at,r.id`, familyID, babyID, dateRange.start, dateRange.end)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	supps, err := many(ctx, q, `SELECT to_jsonb(r) FROM supplement_records r
		WHERE r.family_id=$1 AND r.baby_id=$2 AND r.deleted_at IS NULL AND r.occurred_at >= $3 AND r.occurred_at < $4
		ORDER BY r.occurred_at,r.id`, familyID, babyID, dateRange.start, dateRange.end)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	fromText, toText := dateRange.from.Format("2006-01-02"), dateRange.to.Format("2006-01-02")
	foods, err := many(ctx, q, `SELECT to_jsonb(r) FROM food_records r
		WHERE r.family_id=$1 AND r.baby_id=$2 AND r.deleted_at IS NULL AND r.record_date >= $3 AND r.record_date <= $4
		ORDER BY r.record_date,r.id`, familyID, babyID, fromText, toText)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	formulas, err := many(ctx, q, `SELECT to_jsonb(p) FROM formula_products p
		WHERE p.family_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at,p.id`, familyID)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	products, err := many(ctx, q, `SELECT to_jsonb(p) FROM supplement_products p
		WHERE p.family_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at,p.id`, familyID)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	foodPlan, err := one(ctx, q, `SELECT to_jsonb(p) FROM baby_food_plans p WHERE p.family_id=$1 AND p.baby_id=$2`, familyID, babyID)
	if errors.Is(err, pgx.ErrNoRows) {
		foodPlan = Object{"plan_data": Object{}}
	} else if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	foodLibraryRows, err := many(ctx, q, `SELECT to_jsonb(i) FROM food_library_items i WHERE i.family_id IS NULL OR i.family_id=$1`, familyID)
	if err != nil {
		return nutritionInputs{}, nutritionDateRange{}, legacyQueryFailure(err)
	}
	foodNames := make(map[string]string, len(foodLibraryRows))
	foodProfiles := make(map[string]any, len(foodLibraryRows))
	for _, row := range foodLibraryRows {
		id := text(row["id"])
		foodNames[id] = text(row["name"])
		foodProfiles[id] = row["nutrients_json"]
	}
	return nutritionInputs{
		familyID: familyID, babyID: babyID, birthDate: text(meta["birthDate"]), timeZone: zone,
		feedings: feedings, supps: supps, foods: foods, formulas: formulas, products: products,
		foodNames: foodNames, foodProfiles: foodProfiles, foodPlan: foodPlan,
	}, dateRange, nil
}

func nutritionReferenceDTO() Object {
	return Object{
		"version":          nutritionReferenceVersion,
		"sha256":           nutritionReferenceHash,
		"validationStatus": "legacy_values_not_independently_cross_checked",
		"driSource":        "Chinese Nutrition Society, China Dietary Reference Intakes (2023 edition); numeric rows copied from legacy Web and not individually cross-checked against the source tables.",
		"foodSource":       "Legacy Web comments cite Dietary Guidelines for Chinese Residents (2022), China Food Composition Table standard edition 6, and GB 10769; item-level value citations were not present.",
		"breastmilkSource": "Legacy Web comments cite Chinese dietary guidance and the older WS/T 578 series (2017/2018); numeric values and nursing-volume estimates were not individually cross-checked or mapped to those publications.",
	}
}

func legacyObject(value any) Object { return obj(value) }

func referenceNutrientIDs() []string {
	raw, _ := nutritionReference["nutrientIds"].([]any)
	ids := make([]string, 0, len(raw))
	for _, value := range raw {
		if id := text(value); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}
