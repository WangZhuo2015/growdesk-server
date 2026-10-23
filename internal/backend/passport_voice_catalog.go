package backend

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Catalog data is scoped by the verified device and current baby membership;
// model-provided identifiers never establish access to a family's food items.
func (s *Server) loadPassportVoiceCatalog(ctx context.Context, principal *PassportPrincipal) ([]Object, error) {
	if principal == nil || !time.Now().Before(principal.ExpiresAt) {
		return nil, apiError(401, "INVALID_PASSPORT_TOKEN", "Passport token is expired")
	}
	var active bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM passport_devices
		WHERE id=$1 AND owner_user_id=$2 AND family_id=$3 AND baby_id=$4 AND revoked_at IS NULL)`,
		principal.DeviceID, principal.OwnerUserID, principal.FamilyID, principal.BabyID).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, apiError(403, "DEVICE_ACCESS_REVOKED", "Device access has been revoked or its scope has changed")
	}
	scope, err := babyScope(ctx, s.DB, principal.OwnerUserID, principal.BabyID, false)
	if err != nil {
		return nil, err
	}
	if scope.FamilyID != principal.FamilyID {
		return nil, apiError(403, "BABY_SCOPE_MISMATCH", "Device baby scope has changed")
	}
	rows, err := s.DB.Query(ctx, `SELECT id,name FROM food_library_items
		WHERE family_id IS NULL OR family_id=$1 ORDER BY is_custom DESC,name,id LIMIT 128`, scope.FamilyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	catalog := make([]Object, 0)
	bytes := 0
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		bytes += len(id) + len(name)
		if bytes > 32*1024 {
			break
		}
		catalog = append(catalog, Object{"id": id, "name": name})
	}
	return catalog, rows.Err()
}

func (s *Server) hydratePassportFoodCard(ctx context.Context, principal *PassportPrincipal, projection *passportCardProjection) error {
	if projection == nil || projection.Action.EntityType != "food" {
		return nil
	}
	ids, ok := projection.Action.Payload["foodItemIds"].([]any)
	if !ok || len(ids) == 0 {
		return providerFailure("INVALID_RECORD_PROPOSAL", "Select at least one real food item before confirmation", false)
	}
	names := make([]string, 0, len(ids))
	for _, raw := range ids {
		id, ok := raw.(string)
		if !ok {
			return providerFailure("INVALID_RECORD_PROPOSAL", "Food identifiers are invalid", false)
		}
		var name string
		if err := s.DB.QueryRow(ctx, `SELECT name FROM food_library_items WHERE id=$1 AND (family_id IS NULL OR family_id=$2)`, id, principal.FamilyID).Scan(&name); err != nil {
			return providerFailure("INVALID_RECORD_PROPOSAL", "A proposed food item is unavailable in this family", false)
		}
		names = append(names, name)
	}
	value := strings.Join(names, "、")
	if utf8.RuneCountInString(value) > passportMaxCardValue {
		return providerFailure("INVALID_RECORD_PROPOSAL", "Food names exceed the device display limit; submit fewer items", false)
	}
	for i := range projection.Card.Fields {
		if projection.Card.Fields[i].Label == "食物" || projection.Card.Fields[i].Label == "食物 ID" {
			projection.Card.Fields[i].Label = "食物"
			projection.Card.Fields[i].Value = value
			return nil
		}
	}
	return providerFailure("INVALID_RECORD_PROPOSAL", "Food proposal has no display field", false)
}

// Called by the command's Apply closure after the receipt replay check, while
// the same record transaction/family lock is held. Row locks keep references
// valid through commit, including public catalog rows without a family lock.
func validatePassportFoodReferences(ctx context.Context, tx pgx.Tx, familyID string, payload Object) error {
	ids, ok := payload["foodItemIds"].([]any)
	if !ok || len(ids) == 0 {
		return invalid("Select at least one real food item")
	}
	for _, raw := range ids {
		id, ok := raw.(string)
		if !ok || strings.TrimSpace(id) == "" {
			return invalid("Food identifiers are invalid")
		}
		var found string
		err := tx.QueryRow(ctx, `SELECT id FROM food_library_items WHERE id=$1 AND (family_id IS NULL OR family_id=$2) FOR SHARE`, id, familyID).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiError(400, "FOOD_ITEM_NOT_FOUND", "A proposed food item is unavailable in this family")
		}
		if err != nil {
			return err
		}
	}
	return nil
}
