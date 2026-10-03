package backend

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestNutritionRecordNativeRegistrationAndDTO(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	server.RegisterBusinessHandlers()
	const id = "a0000000-0000-4000-8000-000000000001"
	for _, d := range nutritionRecordSpecs {
		for _, operation := range []string{"list" + d.OperationName + "s", "get" + d.OperationName, "create" + d.OperationName, "update" + d.OperationName, "delete" + d.OperationName} {
			if server.Handlers[operation] == nil || server.Public[operation] {
				t.Fatalf("missing protected native handler %s", operation)
			}
		}
		row := Object{"id": id, "family_id": id, "baby_id": id, "version": json.Number("1"),
			"created_at": "2026-05-02T12:00:00Z", "updated_at": "2026-05-02T12:00:00Z", "deleted_at": nil,
			"record_date": "2026-05-02", "meal_type": "lunch", "food_item_ids": []any{},
			"supplement_name": "test_supplement", "occurred_at": "2026-05-02T12:00:00Z", "dose": json.Number("1.2500"), "recorded_by_user_id": id}
		entity := nutritionRecordEntity(d, row)
		dto := nutritionRecordDTO(d, entity)
		if err := contract.ByID["get"+d.OperationName].ValidateResponse(context.Background(), 200, envelope(dto)); err != nil {
			t.Fatalf("%s DTO: %v", d.Kind, err)
		}
		if _, leaked := dto["deletedAt"]; leaked {
			t.Fatal("persistence-only deletion field leaked")
		}
		if d.Kind == "supplement" && dto["dose"] != "1.25" {
			t.Fatalf("decimal mismatch: %#v", dto)
		}
		change, err := nutritionRecordChange(d, "create", entity)
		if err != nil || iso(change.OccurredAt) != "2026-05-02T12:00:00.000Z" {
			t.Fatalf("invalid event: %#v, %v", change, err)
		}
		deleted, err := nutritionRecordChange(d, "delete", entity)
		if err != nil || deleted.Payload["deleted"] != true || len(deleted.Payload) != 3 {
			t.Fatalf("invalid tombstone: %#v, %v", deleted, err)
		}
	}
}

func TestFoodEventFallbackAndArrayBinding(t *testing.T) {
	d := nutritionRecordSpecs[0]
	entity := Object{"id": "test", "version": 1, "recordDate": "2026-05-02", "occurredAt": nil, "mealType": "lunch", "foodItemIds": []any{}}
	change, err := nutritionRecordChange(d, "update", entity)
	if err != nil || iso(change.OccurredAt) != "2026-05-02T12:00:00.000Z" || change.Payload["occurredAt"] != nil {
		t.Fatalf("nullable time fallback changed public data: %#v, %v", change, err)
	}
	values, err := nutritionRecordValues(d, Object{"foodItemIds": []any{"food_rice", "test_quoted'"}}, false)
	if err != nil || !reflect.DeepEqual(values["food_item_ids"], []string{"food_rice", "test_quoted'"}) {
		t.Fatalf("invalid native PostgreSQL array binding: %#v, %v", values, err)
	}
	if _, err := nutritionRecordValues(d, Object{"foodItemIds": []any{false}}, false); err == nil {
		t.Fatal("non-string array item accepted")
	}
	measured, err := nutritionRecordValues(d, Object{"foodItemIds": []any{"custom_test_food"}, "foodAmountGrams": "12.5"}, true)
	if err != nil || measured["food_amount_grams"] == nil {
		t.Fatalf("positive measured grams were not retained: %#v, %v", measured, err)
	}
	for _, body := range []Object{
		{"foodItemIds": []any{"custom_test_food", "food_egg"}, "foodAmountGrams": "12.5"},
		{"foodItemIds": []any{"custom_test_food"}, "foodAmountGrams": "0"},
		{"foodItemIds": []any{"custom_test_food"}, "foodAmountGrams": "-1"},
		{"foodItemIds": []any{"custom_test_food"}, "foodAmountGrams": "12.123456"},
	} {
		if _, err := nutritionRecordValues(d, body, true); err == nil {
			t.Fatalf("invalid measured food amount was accepted: %#v", body)
		}
	}
	cursor := encodeNutritionCursor(d, "2026-05-02", "test-id")
	date, id, valid := decodeNutritionCursor(d, cursor)
	if !valid || date != "2026-05-02" || id != "test-id" {
		t.Fatal("food cursor lost date-only semantics")
	}
}

func TestMeasuredFoodCreateKeepsLegacyIdempotencyHash(t *testing.T) {
	d := nutritionRecordSpecs[0]
	scope := Scope{FamilyID: "family", BabyID: "baby"}
	body := Object{"recordDate": "2026-05-02", "mealType": "lunch", "foodItemIds": []any{"food_rice"}}
	want := hashText(`{"operation":"create","entityType":"food","familyId":"family","babyId":"baby","recordDate":"2026-05-02","mealType":"lunch","occurredAt":null,"foodItemIds":["food_rice"],"portionDescription":null,"reaction":null,"notes":null}`)
	legacy, _, err := nutritionRecordHashes(d, "create", scope, "generated", 0, body)
	if err != nil || legacy != want {
		t.Fatalf("old create request hash changed when measured grams are omitted: %s (%v)", legacy, err)
	}
	measured, _, err := nutritionRecordHashes(d, "create", scope, "generated", 0, Object{
		"recordDate": "2026-05-02", "mealType": "lunch", "foodItemIds": []any{"food_rice"}, "foodAmountGrams": "12.5",
	})
	if err != nil || measured == legacy {
		t.Fatalf("explicit measured grams were not included in the create idempotency hash: %s (%v)", measured, err)
	}
}

func TestNutritionReferenceHashAndExplicitNullDigest(t *testing.T) {
	d := nutritionRecordSpecs[0]
	scope := Scope{FamilyID: "family", BabyID: "baby"}
	body := Object{"recordDate": "2026-05-02", "mealType": "lunch", "foodItemIds": []any{"food_rice"}}
	hash, digest, err := nutritionRecordHashes(d, "create", scope, "ignored-generated-id", 0, body)
	want := hashText(`{"operation":"create","entityType":"food","familyId":"family","babyId":"baby","recordDate":"2026-05-02","mealType":"lunch","occurredAt":null,"foodItemIds":["food_rice"],"portionDescription":null,"reaction":null,"notes":null}`)
	if err != nil || hash != want || digest != hash {
		t.Fatalf("reference hash changed: %s, %v", hash, err)
	}
	omitted, omittedDigest, err := nutritionRecordHashes(d, "update", scope, "record", 1, Object{"baseVersion": "1"})
	if err != nil {
		t.Fatal(err)
	}
	cleared, clearDigest, err := nutritionRecordHashes(d, "update", scope, "record", 1, Object{"baseVersion": "1", "occurredAt": nil})
	if err != nil || cleared != omitted || clearDigest == omittedDigest {
		t.Fatalf("reference and unambiguous native digests not separated: %v", err)
	}
}
