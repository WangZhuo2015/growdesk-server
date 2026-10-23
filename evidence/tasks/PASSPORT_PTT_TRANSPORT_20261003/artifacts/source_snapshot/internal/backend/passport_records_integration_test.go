package backend

import (
	"context"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type passportRecordIntegrationCase struct {
	name, wireKind, kind, table string
	build                       func(*passportConfirmationFixture, time.Time, string) (Object, Object)
	seedFood                    bool
}

func TestPassportConfirmedRecordsIntegration(t *testing.T) {
	h := newPassportConfirmationPG(t)
	guardCtx, guardCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer guardCancel()
	for _, table := range []string{
		"feeding_records", "sleep_records", "diaper_records", "food_records",
		"supplement_records", "growth_measurements", "food_library_items",
	} {
		var exists bool
		if err := h.controlDB.QueryRow(guardCtx, `SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			t.Fatalf("check migrated test table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("test database is missing public.%s; apply the tracked Prisma migrations", table)
		}
	}

	cases := []passportRecordIntegrationCase{
		{
			name: "feeding", wireKind: "feeding", kind: "feeding", table: "feeding_records",
			build: func(_ *passportConfirmationFixture, at time.Time, _ string) (Object, Object) {
				return Object{"feedingType": "formula", "amountMl": "145.500", "occurredAt": at.Format(time.RFC3339Nano), "notes": "test feeding note"},
					Object{"feeding_type": "formula", "amount_ml": passportExpectedNumber("145.500"), "occurred_at": at, "notes": "test feeding note", "source": "passport", "source_agent": "passport"}
			},
		},
		{
			name: "sleep", wireKind: "sleep", kind: "sleep", table: "sleep_records",
			build: func(_ *passportConfirmationFixture, at time.Time, _ string) (Object, Object) {
				started, ended := at.Add(-45*time.Minute), at
				return Object{"sleepType": "nap", "startedAt": started.Format(time.RFC3339Nano), "endedAt": ended.Format(time.RFC3339Nano), "nightWakingCount": 1, "notes": "test sleep note"},
					Object{"sleep_type": "nap", "started_at": started, "ended_at": ended, "night_waking_count": passportExpectedNumber("1"), "notes": "test sleep note", "source": "passport", "source_agent": "passport"}
			},
		},
		{
			name: "diaper", wireKind: "diaper", kind: "diaper", table: "diaper_records",
			build: func(_ *passportConfirmationFixture, at time.Time, _ string) (Object, Object) {
				return Object{"diaperType": "both", "occurredAt": at.Format(time.RFC3339Nano), "poopColor": "brown", "poopConsistency": "soft", "notes": "test diaper note"},
					Object{"diaper_type": "both", "occurred_at": at, "poop_color": "brown", "poop_consistency": "soft", "notes": "test diaper note", "source": "passport", "source_agent": "passport"}
			},
		},
		{
			name: "food alias", wireKind: "foodLog", kind: "food", table: "food_records", seedFood: true,
			build: func(_ *passportConfirmationFixture, at time.Time, foodID string) (Object, Object) {
				return Object{"recordDate": at.Format("2006-01-02"), "mealType": "lunch", "occurredAt": at.Format(time.RFC3339Nano), "foodItemIds": []any{foodID}, "portionDescription": "test portion", "reaction": "like", "notes": "test food note"},
					Object{"record_date": at.Format("2006-01-02"), "meal_type": "lunch", "occurred_at": at, "food_item_ids": []string{foodID}, "portion_description": "test portion", "reaction": "like", "notes": "test food note", "source": "passport", "source_agent": "passport"}
			},
		},
		{
			name: "supplement alias", wireKind: "supplementRecord", kind: "supplement", table: "supplement_records",
			build: func(_ *passportConfirmationFixture, at time.Time, _ string) (Object, Object) {
				return Object{"supplementName": "test_vitamin_d", "occurredAt": at.Format(time.RFC3339Nano), "amount": "1.25 mL", "dose": "1.25000", "unitName": "mL", "notes": "test supplement note"},
					Object{"supplement_name": "test_vitamin_d", "occurred_at": at, "amount": "1.25 mL", "dose": passportExpectedNumber("1.25000"), "unit_name": "mL", "notes": "test supplement note", "product_id": nil, "source": "passport", "source_agent": "passport"}
			},
		},
		{
			name: "growth alias", wireKind: "growthMeasurement", kind: "growth", table: "growth_measurements",
			build: func(_ *passportConfirmationFixture, at time.Time, _ string) (Object, Object) {
				return Object{"measurementDate": at.Format("2006-01-02"), "weightKg": "6.25", "heightCm": "61.2", "headCircumferenceCm": "40.1", "notes": "test growth note"},
					Object{"measurement_date": at.Format("2006-01-02"), "weight_kg": passportExpectedNumber("6.25"), "height_cm": passportExpectedNumber("61.2"), "head_circumference_cm": passportExpectedNumber("40.1"), "notes": "test growth note", "attachment_id": nil}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newPassportConfirmationFixture(t, h.controlDB)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			at := time.Now().UTC().Truncate(time.Millisecond)
			foodID := ""
			if tc.seedFood {
				foodID = seedPassportTestFoodItem(t, ctx, h.controlDB, fx)
			}
			payload, expected := tc.build(fx, at, foodID)
			// Deliberately supply client-owned scope/source hints. The trusted
			// session scope and Passport source must be what reaches PostgreSQL.
			payload["familyId"] = "test_forged_family"
			payload["babyId"] = "test_forged_baby"
			payload["id"] = "test_forged_record"
			payload["source"] = "test_forged_source"
			payload["sourceAgent"] = "test_forged_agent"
			actionID, runID, planHash := newID(), newID(), "test_plan_"+newID()
			action := nativeAIAction{ActionID: actionID, EntityType: tc.wireKind, Operation: "create", Summary: "Test Passport " + tc.kind + " record", Payload: payload}

			firstID, err := h.server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, actionID, planHash, action, time.Now().Add(2*time.Minute))
			if err != nil {
				t.Fatalf("create %s Passport record: %v", tc.kind, err)
			}
			if firstID == "" {
				t.Fatal("create returned an empty record id")
			}
			requirePassportPersistedRecord(t, ctx, h.controlDB, tc.table, firstID, fx, expected)
			requirePassportTableRecordCount(t, ctx, h.controlDB, tc.table, fx, 1)

			// Replay the same confirmation through the canonical entity name.
			// Alias normalization and the normal receipt path must return the
			// original row without creating another record.
			replay := action
			replay.EntityType = tc.kind
			replayID, err := h.server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, actionID, planHash, replay, time.Now().Add(2*time.Minute))
			if err != nil {
				t.Fatalf("replay %s Passport confirmation: %v", tc.kind, err)
			}
			if replayID != firstID {
				t.Fatalf("replay returned record id %q, want original %q", replayID, firstID)
			}
			requirePassportTableRecordCount(t, ctx, h.controlDB, tc.table, fx, 1)
		})
	}

	t.Run("missing required field writes no record", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		id, runID, planHash := newID(), newID(), "test_plan_"+newID()
		action := nativeAIAction{ActionID: id, EntityType: "feeding", Operation: "create", Summary: "Test invalid feeding", Payload: Object{"amountMl": "20"}}
		recordID, err := h.server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, id, planHash, action, time.Now().Add(2*time.Minute))
		if err == nil || recordID != "" {
			t.Fatalf("invalid create returned record id %q and error %v; want an error and no record id", recordID, err)
		}
		requirePassportTableRecordCount(t, ctx, h.controlDB, "feeding_records", fx, 0)
	})

	t.Run("non-create operation writes no record", func(t *testing.T) {
		fx := newPassportConfirmationFixture(t, h.controlDB)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		id, runID, planHash := newID(), newID(), "test_plan_"+newID()
		action := nativeAIAction{ActionID: id, EntityType: "feeding", Operation: "update", Summary: "Test invalid feeding update", Payload: Object{"feedingType": "formula", "occurredAt": time.Now().UTC().Format(time.RFC3339Nano)}}
		recordID, err := h.server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, id, planHash, action, time.Now().Add(2*time.Minute))
		if err == nil || recordID != "" {
			t.Fatalf("non-create operation returned record id %q and error %v; want an error and no record id", recordID, err)
		}
		requirePassportTableRecordCount(t, ctx, h.controlDB, "feeding_records", fx, 0)
	})
}

type passportExpectedNumber string

func seedPassportTestFoodItem(t *testing.T, ctx context.Context, db *pgxpool.Pool, fx *passportConfirmationFixture) string {
	t.Helper()
	foodID := "test_food_" + strings.ReplaceAll(newID(), "-", "")
	// The item is scoped to this independently generated test family. Never
	// select an existing catalog row as a fixture.
	_, err := db.Exec(ctx, `INSERT INTO food_library_items(
		id,name,category,allergen_risk,recommended_age_months,is_custom,family_id,created_at,updated_at
	) VALUES($1,'Test Passport Pear','fruit','low',6,true,$2,clock_timestamp(),clock_timestamp())`, foodID, fx.familyID)
	if err != nil {
		t.Fatalf("seed test-owned food library item: %v", err)
	}
	return foodID
}

func requirePassportPersistedRecord(t *testing.T, ctx context.Context, db *pgxpool.Pool, table, recordID string, fx *passportConfirmationFixture, expected Object) {
	t.Helper()
	query := "SELECT to_jsonb(r) FROM public." + pgx.Identifier{table}.Sanitize() + " r WHERE id=$1 AND family_id=$2 AND baby_id=$3"
	row, err := one(ctx, db, query, recordID, fx.familyID, fx.babyID)
	if err != nil {
		t.Fatalf("read persisted test %s record: %v", table, err)
	}
	common := Object{"id": recordID, "family_id": fx.familyID, "baby_id": fx.babyID, "version": passportExpectedNumber("1"), "deleted_at": nil}
	if table != "growth_measurements" {
		common["source"] = "passport"
		if table == "feeding_records" || table == "sleep_records" || table == "diaper_records" {
			common["source_agent"] = "passport"
		} else {
			// Food and supplement create contracts have no sourceAgent request
			// property; normalizeBody removes it before the insert callback.
			common["source_agent"] = nil
		}
	}
	if table == "feeding_records" || table == "sleep_records" || table == "diaper_records" || table == "supplement_records" {
		common["recorded_by_user_id"] = fx.userID
	}
	for column, value := range common {
		expected[column] = value
	}
	for column, want := range expected {
		got, ok := row[column]
		if !ok {
			t.Errorf("persisted %s record lacks column %s", table, column)
			continue
		}
		if err := comparePassportPersistedValue(column, got, want); err != nil {
			t.Errorf("persisted %s.%s = %#v, want %#v: %v", table, column, got, want, err)
		}
	}
}

func comparePassportPersistedValue(column string, got, want any) error {
	switch expected := want.(type) {
	case passportExpectedNumber:
		wantNumber, ok := new(big.Rat).SetString(string(expected))
		if !ok {
			return fmt.Errorf("invalid expected number %q", expected)
		}
		gotNumber, ok := new(big.Rat).SetString(text(got))
		if !ok || gotNumber.Cmp(wantNumber) != 0 {
			return fmt.Errorf("numeric value differs")
		}
	case time.Time:
		value, ok := got.(string)
		if !ok {
			return fmt.Errorf("want timestamp string, got %T", got)
		}
		actual, err := time.Parse(time.RFC3339Nano, value)
		if err != nil || !actual.Equal(expected) {
			return fmt.Errorf("timestamp differs (actual %q, parse error %v)", value, err)
		}
	case []string:
		actual, ok := got.([]any)
		if !ok {
			return fmt.Errorf("want JSON array, got %T", got)
		}
		values := make([]string, len(actual))
		for i, item := range actual {
			value, ok := item.(string)
			if !ok {
				return fmt.Errorf("array item %d has type %T", i, item)
			}
			values[i] = value
		}
		if !reflect.DeepEqual(values, expected) {
			return fmt.Errorf("array value differs")
		}
	case nil:
		if got != nil {
			return fmt.Errorf("want null")
		}
	case string:
		if text(got) != expected {
			return fmt.Errorf("string value differs (got %q)", text(got))
		}
	default:
		if !reflect.DeepEqual(got, expected) {
			return fmt.Errorf("value differs")
		}
	}
	return nil
}

func requirePassportTableRecordCount(t *testing.T, ctx context.Context, db *pgxpool.Pool, table string, fx *passportConfirmationFixture, want int) {
	t.Helper()
	query := "SELECT count(*) FROM public." + pgx.Identifier{table}.Sanitize() + " WHERE family_id=$1 AND baby_id=$2"
	var count int
	if err := db.QueryRow(ctx, query, fx.familyID, fx.babyID).Scan(&count); err != nil {
		t.Fatalf("count test %s records: %v", table, err)
	}
	if count != want {
		t.Fatalf("%s record count = %d, want %d", table, count, want)
	}
}
