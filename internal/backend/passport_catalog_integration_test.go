package backend

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPassportFoodCatalogContextIntegration(t *testing.T) {
	h := newPassportConfirmationPG(t)
	fxA := newPassportConfirmationFixture(t, h.controlDB)
	fxB := newPassportConfirmationFixture(t, h.controlDB)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	globalID := seedPassportCatalogFood(t, ctx, h.controlDB, "", "Test Global Pear")
	foodAID := seedPassportCatalogFood(t, ctx, h.controlDB, fxA.familyID, "Test Family A Pear")
	foodBID := seedPassportCatalogFood(t, ctx, h.controlDB, fxB.familyID, "Test Family B Pear")
	deletedAfterCardID := seedPassportCatalogFood(t, ctx, h.controlDB, fxA.familyID, "Test Pending Pear")

	t.Run("catalog is limited to global and the verified family", func(t *testing.T) {
		catalog, err := h.server.loadPassportVoiceCatalog(ctx, fxA.principal)
		if err != nil {
			t.Fatalf("load family A voice catalog: %v", err)
		}
		byID := passportCatalogNames(catalog)
		for id, name := range map[string]string{globalID: "Test Global Pear", foodAID: "Test Family A Pear", deletedAfterCardID: "Test Pending Pear"} {
			if byID[id] != name {
				t.Errorf("family A catalog[%q] = %q, want %q", id, byID[id], name)
			}
		}
		if _, found := byID[foodBID]; found {
			t.Fatalf("family A catalog exposed family B food %q", foodBID)
		}
		requirePassportCatalogFamilyScope(t, ctx, h.controlDB, catalog, fxA.familyID)

		catalogB, err := h.server.loadPassportVoiceCatalog(ctx, fxB.principal)
		if err != nil {
			t.Fatalf("load family B voice catalog: %v", err)
		}
		byIDB := passportCatalogNames(catalogB)
		if byIDB[globalID] != "Test Global Pear" || byIDB[foodBID] != "Test Family B Pear" {
			t.Fatalf("family B catalog lacks global or own test food: %#v", byIDB)
		}
		if _, found := byIDB[foodAID]; found {
			t.Fatalf("family B catalog exposed family A food %q", foodAID)
		}
		requirePassportCatalogFamilyScope(t, ctx, h.controlDB, catalogB, fxB.familyID)
	})

	t.Run("food card displays real catalog names", func(t *testing.T) {
		projection := passportFoodCatalogProjection(t, h.server, globalID, foodAID)
		if err := h.server.hydratePassportFoodCard(ctx, fxA.principal, projection); err != nil {
			t.Fatalf("hydrate food card from family A catalog: %v", err)
		}
		field, ok := fieldByLabel(projection.Card.Fields, "食物")
		want := "Test Global Pear、Test Family A Pear"
		if !ok || field.Value != want {
			t.Fatalf("food card field = %+v, present=%t; want actual catalog names %q", field, ok, want)
		}
	})

	t.Run("unknown and other-family foods cannot hydrate a card", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			id   string
		}{{"unknown", "test_food_unknown_" + strings.ReplaceAll(newID(), "-", "")}, {"other family", foodBID}} {
			t.Run(tc.name, func(t *testing.T) {
				projection := passportFoodCatalogProjection(t, h.server, tc.id)
				err := h.server.hydratePassportFoodCard(ctx, fxA.principal, projection)
				requirePassportProviderError(t, err, "INVALID_RECORD_PROPOSAL")
			})
		}
	})

	t.Run("confirmation rejects unknown and cross-family food references without writes", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			id   string
		}{{"unknown", "test_food_unknown_" + strings.ReplaceAll(newID(), "-", "")}, {"other family", foodBID}} {
			t.Run(tc.name, func(t *testing.T) {
				id, err := confirmPassportCatalogFood(ctx, h.server, fxA, tc.id, newID(), newID(), "test_plan_"+newID())
				requirePassportConfirmationError(t, err, "FOOD_ITEM_NOT_FOUND")
				if id != "" {
					t.Fatalf("rejected food confirmation returned record id %q", id)
				}
				requirePassportTableRecordCount(t, ctx, h.controlDB, "food_records", fxA, 0)
			})
		}
	})

	t.Run("confirm rejects a catalog item deleted after its card was hydrated", func(t *testing.T) {
		runID, actionID, planHash := newID(), newID(), "test_plan_"+newID()
		projection := passportFoodCatalogProjectionWithActionID(t, h.server, actionID, deletedAfterCardID)
		if err := h.server.hydratePassportFoodCard(ctx, fxA.principal, projection); err != nil {
			t.Fatalf("hydrate valid pending food card: %v", err)
		}
		if _, err := h.controlDB.Exec(ctx, `DELETE FROM food_library_items WHERE id=$1 AND family_id=$2`, deletedAfterCardID, fxA.familyID); err != nil {
			t.Fatalf("remove pending test food item: %v", err)
		}

		recordID, err := h.server.executePassportCardConfirmation(ctx, fxA.principal, runID, planHash, actionID, planHash, projection.Action, time.Now().Add(2*time.Minute))
		requirePassportConfirmationError(t, err, "FOOD_ITEM_NOT_FOUND")
		if recordID != "" {
			t.Fatalf("deleted food confirmation returned record id %q", recordID)
		}
		requirePassportTableRecordCount(t, ctx, h.controlDB, "food_records", fxA, 0)
	})

	t.Run("receipt replay returns the committed record after catalog deletion", func(t *testing.T) {
		runID, actionID, planHash := newID(), newID(), "test_plan_"+newID()
		projection := passportFoodCatalogProjectionWithActionID(t, h.server, actionID, globalID)
		if err := h.server.hydratePassportFoodCard(ctx, fxA.principal, projection); err != nil {
			t.Fatalf("hydrate valid global-food card: %v", err)
		}
		firstID, err := h.server.executePassportCardConfirmation(ctx, fxA.principal, runID, planHash, actionID, planHash, projection.Action, time.Now().Add(2*time.Minute))
		if err != nil {
			t.Fatalf("create global-food record: %v", err)
		}
		if firstID == "" {
			t.Fatal("global-food create returned an empty record id")
		}
		requirePassportTableRecordCount(t, ctx, h.controlDB, "food_records", fxA, 1)
		if _, err := h.controlDB.Exec(ctx, `DELETE FROM food_library_items WHERE id=$1 AND family_id IS NULL`, globalID); err != nil {
			t.Fatalf("remove committed test global food item: %v", err)
		}

		replay := projection.Action
		replay.EntityType = "food"
		replayID, err := h.server.executePassportCardConfirmation(ctx, fxA.principal, runID, planHash, actionID, planHash, replay, time.Now().Add(2*time.Minute))
		if err != nil {
			t.Fatalf("replay committed record after food deletion: %v", err)
		}
		if replayID != firstID {
			t.Fatalf("receipt replay returned %q, want original id %q", replayID, firstID)
		}
		requirePassportTableRecordCount(t, ctx, h.controlDB, "food_records", fxA, 1)
	})

	t.Run("catalog reload rejects a revoked device", func(t *testing.T) {
		if _, err := h.controlDB.Exec(ctx, `UPDATE passport_devices SET revoked_at=clock_timestamp() WHERE id=$1`, fxA.deviceID); err != nil {
			t.Fatalf("revoke family A test device: %v", err)
		}
		_, err := h.server.loadPassportVoiceCatalog(ctx, fxA.principal)
		requirePassportConfirmationError(t, err, "DEVICE_ACCESS_REVOKED")
	})

	t.Run("catalog reload rejects revoked baby membership", func(t *testing.T) {
		if _, err := h.controlDB.Exec(ctx, `UPDATE baby_members SET status='revoked',updated_at=clock_timestamp() WHERE baby_id=$1 AND family_id=$2 AND user_id=$3`, fxB.babyID, fxB.familyID, fxB.userID); err != nil {
			t.Fatalf("revoke family B test baby membership: %v", err)
		}
		_, err := h.server.loadPassportVoiceCatalog(ctx, fxB.principal)
		requirePassportConfirmationError(t, err, "BABY_ACCESS_DENIED")
	})
}

func seedPassportCatalogFood(t *testing.T, ctx context.Context, db *pgxpool.Pool, familyID, name string) string {
	t.Helper()
	foodID := "test_food_" + strings.ReplaceAll(newID(), "-", "")
	var family any
	if familyID != "" {
		family = familyID
	}
	_, err := db.Exec(ctx, `INSERT INTO food_library_items(
		id,name,category,allergen_risk,recommended_age_months,is_custom,family_id,created_at,updated_at
	) VALUES($1,$2,'fruit','low',6,$3,$4,clock_timestamp(),clock_timestamp())`, foodID, name, familyID != "", family)
	if err != nil {
		t.Fatalf("seed isolated test food %q: %v", foodID, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, cleanupErr := db.Exec(cleanupCtx, `DELETE FROM food_library_items WHERE id=$1`, foodID); cleanupErr != nil {
			t.Errorf("remove isolated test food %q: %v", foodID, cleanupErr)
		}
	})
	return foodID
}

func passportCatalogNames(catalog []Object) map[string]string {
	byID := make(map[string]string, len(catalog))
	for _, entry := range catalog {
		byID[text(entry["id"])] = text(entry["name"])
	}
	return byID
}

func requirePassportCatalogFamilyScope(t *testing.T, ctx context.Context, db *pgxpool.Pool, catalog []Object, familyID string) {
	t.Helper()
	for _, entry := range catalog {
		id := text(entry["id"])
		var allowed bool
		if err := db.QueryRow(ctx, `SELECT family_id IS NULL OR family_id=$2 FROM food_library_items WHERE id=$1`, id, familyID).Scan(&allowed); err != nil {
			t.Fatalf("resolve catalog food %q family: %v", id, err)
		}
		if !allowed {
			t.Errorf("catalog exposed non-global food %q outside family %q", id, familyID)
		}
	}
}

func passportFoodCatalogProjection(t *testing.T, server *Server, ids ...string) *passportCardProjection {
	t.Helper()
	return passportFoodCatalogProjectionWithActionID(t, server, newID(), ids...)
}

func passportFoodCatalogProjectionWithActionID(t *testing.T, server *Server, actionID string, ids ...string) *passportCardProjection {
	t.Helper()
	foodIDs := make([]any, 0, len(ids))
	for _, id := range ids {
		foodIDs = append(foodIDs, id)
	}
	action := nativeAIAction{
		ActionID: actionID, EntityType: "foodLog", Operation: "create", Summary: "Test Passport food proposal",
		Payload: Object{"recordDate": time.Now().UTC().Format("2006-01-02"), "mealType": "snack", "foodItemIds": foodIDs, "portionDescription": "test portion"},
	}
	projection, err := server.projectValidatedPassportActions([]nativeAIAction{action})
	if err != nil {
		t.Fatalf("project test food proposal: %v", err)
	}
	if projection == nil || projection.Action.EntityType != "food" {
		t.Fatalf("food proposal was not canonicalized: %#v", projection)
	}
	return projection
}

func confirmPassportCatalogFood(ctx context.Context, server *Server, fx *passportConfirmationFixture, foodID, runID, actionID, planHash string) (string, error) {
	action := nativeAIAction{
		ActionID: actionID, EntityType: "foodLog", Operation: "create", Summary: "Test Passport food confirmation",
		Payload: Object{"recordDate": time.Now().UTC().Format("2006-01-02"), "mealType": "snack", "foodItemIds": []any{foodID}, "portionDescription": "test portion"},
	}
	return server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, actionID, planHash, action, time.Now().Add(2*time.Minute))
}

func requirePassportProviderError(t *testing.T, err error, code string) {
	t.Helper()
	var providerErr *nativeProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("expected Passport provider error %s, got %v", code, err)
	}
	if providerErr.Code != code {
		t.Fatalf("expected Passport provider error %s, got %s: %v", code, providerErr.Code, err)
	}
}
