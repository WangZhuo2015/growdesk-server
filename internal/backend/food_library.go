package backend

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// These DTOs deliberately exclude persistence-only fields. A missing status is
// omitted; an explicitly stored false status is not the same as an absent row.
type foodLibraryStatus struct {
	Tried    bool    `json:"tried"`
	Reaction *string `json:"reaction"`
}

type foodLibraryItem struct {
	ID                   string             `json:"id"`
	Name                 string             `json:"name"`
	Category             string             `json:"category"`
	AllergenRisk         string             `json:"allergenRisk"`
	RecommendedAgeMonths int64              `json:"recommendedAgeMonths"`
	FamilyStatus         *foodLibraryStatus `json:"familyStatus,omitempty"`
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
	s.Register("listFoodLibraryItems", false, s.listFoodLibraryItems)
	s.Register("createFoodLibraryItem", false, s.createFoodLibraryItem)
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
		SELECT jsonb_agg(jsonb_build_object(
			'id',i.id,'name',i.name,'category',i.category,'allergenRisk',i.allergen_risk,
			'recommendedAgeMonths',i.recommended_age_months)
			|| CASE WHEN fs.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
				'familyStatus',jsonb_build_object('tried',fs.tried,'reaction',fs.reaction)) END
			ORDER BY i.recommended_age_months ASC,i.name ASC)
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
	items := make([]foodLibraryItem, 0)
	if err := decodeJSON(raw, &items); err != nil {
		return Result{}, err
	}
	return ok(items)
}

func (s *Server) createFoodLibraryItem(ctx context.Context, r *Request) (Result, error) {
	familyID, err := foodLibraryFamily(ctx, s.DB, r.Principal.UserID, text(r.Body["familyId"]))
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if _, err = lockFamily(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	role, err := familyRole(ctx, tx, r.Principal.UserID, familyID)
	if err != nil {
		return Result{}, err
	}
	if role == "viewer" {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Access denied to family: "+familyID)
	}
	item := foodLibraryItem{
		ID: "custom_" + newID(), Name: text(r.Body["name"]), Category: text(r.Body["category"]),
		AllergenRisk: text(r.Body["allergenRisk"]), RecommendedAgeMonths: integer(r.Body["recommendedAgeMonths"]),
	}
	_, err = tx.Exec(ctx, `INSERT INTO food_library_items
		(id,name,category,allergen_risk,recommended_age_months,is_custom,family_id,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,true,$6,NOW(),NOW())`, item.ID, item.Name, item.Category,
		item.AllergenRisk, item.RecommendedAgeMonths, familyID)
	if err != nil {
		return Result{}, err
	}
	if tried, present := r.Body["tried"]; present {
		item.FamilyStatus = &foodLibraryStatus{Tried: boolean(tried)}
		_, err = tx.Exec(ctx, `INSERT INTO family_food_statuses
			(id,family_id,food_item_id,tried,reaction,created_at,updated_at)
			VALUES($1,$2,$3,$4,NULL,NOW(),NOW())`, newID(), familyID, item.ID, item.FamilyStatus.Tried)
		if err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	// The real frozen Fastify route returns this DTO without a data envelope.
	// Its generated OpenAPI disagrees; see the explicit drift regression and
	// real-HTTP differential suite. This operation has no idempotency protocol.
	return Result{Status: http.StatusCreated, Body: item}, nil
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
