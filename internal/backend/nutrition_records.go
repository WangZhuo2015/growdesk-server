package backend

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var nutritionRecordSpecs = []careSpec{
	{Kind: "food", Table: "food_records", OperationName: "FoodRecord", Clock: "record_date", Fields: []careField{
		{Wire: "recordDate", Column: "record_date", Type: "text"},
		{Wire: "mealType", Column: "meal_type", Type: "text"},
		{Wire: "occurredAt", Column: "occurred_at", Type: "time"},
		{Wire: "foodItemIds", Column: "food_item_ids", Type: "strings", Default: []string{}},
		{Wire: "foodAmountGrams", Column: "food_amount_grams", Type: "decimal"},
		{Wire: "portionDescription", Column: "portion_description", Type: "text"},
		{Wire: "reaction", Column: "reaction", Type: "text"},
		{Wire: "notes", Column: "notes", Type: "text"},
	}},
	{Kind: "supplement", Table: "supplement_records", OperationName: "SupplementRecord", Clock: "occurred_at", Fields: []careField{
		{Wire: "supplementName", Column: "supplement_name", Type: "text"},
		{Wire: "productId", Column: "product_id", Type: "text"},
		{Wire: "occurredAt", Column: "occurred_at", Type: "time"},
		{Wire: "amount", Column: "amount", Type: "text"},
		{Wire: "dose", Column: "dose", Type: "decimal"},
		{Wire: "unitName", Column: "unit_name", Type: "text"},
		{Wire: "notes", Column: "notes", Type: "text"},
	}},
}

func (s *Server) registerNutritionRecords() {
	for _, spec := range nutritionRecordSpecs {
		d := spec
		s.Register("list"+d.OperationName+"s", false, func(ctx context.Context, r *Request) (Result, error) { return s.listNutritionRecords(ctx, r, d) })
		s.Register("get"+d.OperationName, false, func(ctx context.Context, r *Request) (Result, error) { return s.getNutritionRecord(ctx, r, d) })
		for _, operation := range []string{"create", "update", "delete"} {
			op := operation
			s.Register(op+d.OperationName, false, func(ctx context.Context, r *Request) (Result, error) { return s.mutateNutritionRecord(ctx, r, d, op) })
		}
	}
}

func nutritionRecordEntity(d careSpec, row Object) Object {
	entity := careEntity(d, row)
	if d.Kind == "supplement" {
		entity["dose"] = decimalValue(row["dose"])
	} else if d.Kind == "food" {
		entity["foodAmountGrams"] = decimalValue(row["food_amount_grams"])
	}
	return entity
}

func nutritionRecordDTO(d careSpec, entity Object) Object {
	value := Object{"id": entity["id"], "babyId": entity["babyId"], "familyId": entity["familyId"],
		"version": text(entity["version"]), "createdAt": isoValue(entity["createdAt"]), "updatedAt": isoValue(entity["updatedAt"])}
	for _, field := range d.Fields {
		item := entity[field.Wire]
		if field.Type == "time" {
			item = isoValue(item)
		}
		if field.Type == "decimal" {
			item = decimalValue(item)
		}
		value[field.Wire] = item
	}
	if d.Kind == "supplement" {
		value["recordedByUserId"] = entity["recordedByUserId"]
	}
	return value
}

func decodeNutritionCursor(d careSpec, cursor string) (any, string, bool) {
	if d.Kind != "food" {
		t, id, valid := decodeCareCursor(cursor)
		return t, id, valid
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(cursor, "="))
	if err != nil {
		return nil, "", false
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return nil, "", false
	}
	return parts[0], parts[1], true
}

func encodeNutritionCursor(d careSpec, clock, id any) string {
	if d.Kind != "food" {
		return encodeCareCursor(clock, id)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(text(clock) + "|" + text(id)))
}

func (s *Server) listNutritionRecords(ctx context.Context, r *Request, d careSpec) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		args := []any{scope.FamilyID, scope.BabyID}
		where := "family_id=$1 AND baby_id=$2 AND deleted_at IS NULL"
		clock := pgx.Identifier{d.Clock}.Sanitize()
		if before, id, valid := decodeNutritionCursor(d, r.HTTP.URL.Query().Get("cursor")); valid {
			args = append(args, before, id)
			where += " AND (" + clock + ",id)<($3,$4)"
		}
		limit := pageLimit(r)
		args = append(args, limit+1)
		rows, err := many(ctx, q, "SELECT to_jsonb(t) FROM "+pgx.Identifier{d.Table}.Sanitize()+" t WHERE "+where+" ORDER BY "+clock+" DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
		if err != nil {
			return Result{}, err
		}
		var next any
		if len(rows) > limit {
			rows = rows[:limit]
			last := rows[len(rows)-1]
			next = encodeNutritionCursor(d, last[d.Clock], last["id"])
		}
		data := make([]Object, 0, len(rows))
		for _, row := range rows {
			data = append(data, nutritionRecordDTO(d, nutritionRecordEntity(d, row)))
		}
		return Result{Status: 200, Body: page(data, next)}, nil
	})
}

func (s *Server) getNutritionRecord(ctx context.Context, r *Request, d careSpec) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil {
			return Result{}, err
		}
		row, err := one(ctx, q, "SELECT to_jsonb(t) FROM "+pgx.Identifier{d.Table}.Sanitize()+" t WHERE family_id=$1 AND baby_id=$2 AND id=$3 AND deleted_at IS NULL", scope.FamilyID, scope.BabyID, r.Params["id"])
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, notFound(d.Kind+"_record", r.Params["id"])
		}
		if err != nil {
			return Result{}, err
		}
		return ok(nutritionRecordDTO(d, nutritionRecordEntity(d, row)))
	})
}

func nutritionRecordHashes(d careSpec, op string, scope Scope, id string, version int64, body Object) (string, string, error) {
	if d.Kind == "food" && op == "create" {
		if grams, supplied := body["foodAmountGrams"]; !supplied || grams == nil {
			// Preserve idempotency for legacy clients whose create hash predates
			// the optional measured-mass field.
			legacy := d
			legacy.Fields = make([]careField, 0, len(d.Fields)-1)
			for _, field := range d.Fields {
				if field.Wire != "foodAmountGrams" {
					legacy.Fields = append(legacy.Fields, field)
				}
			}
			hash, err := careRequestHash(legacy, op, scope, id, version, body)
			return hash, hash, err
		}
	}
	strictHash, err := careRequestHash(d, op, scope, id, version, body)
	if err != nil {
		return "", "", err
	}
	if d.Kind == "food" && op == "update" {
		// The TS optional-chain hash omits occurredAt when it is explicitly
		// cleared. Preserve the wire-compatible primary hash, but retain the
		// unambiguous digest on new receipts so null and omission cannot replay
		// each other's different business mutations within the native runtime.
		if value, exists := body["occurredAt"]; exists && value == nil {
			compatible := copyObject(body)
			delete(compatible, "occurredAt")
			hash, err := careRequestHash(d, op, scope, id, version, compatible)
			return hash, strictHash, err
		}
	}
	return strictHash, strictHash, nil
}

func nutritionRecordValues(d careSpec, body Object, create bool) (Object, error) {
	if d.Kind == "food" {
		if raw, exists := body["foodAmountGrams"]; exists && raw != nil {
			amount, ok := nutritionRat(raw)
			wire := text(raw)
			parts := strings.Split(wire, ".")
			if !ok || amount.Sign() <= 0 || len(parts) > 2 || len(parts[0]) > 7 || (len(parts) == 2 && len(parts[1]) > 5) {
				return nil, invalid("foodAmountGrams must be positive and fit at most five decimal places")
			}
		}
	}
	values, err := careValues(d, body, create)
	if err != nil {
		return nil, err
	}
	if raw, present := values["food_item_ids"]; present {
		switch items := raw.(type) {
		case []string:
			values["food_item_ids"] = append([]string{}, items...)
		case []any:
			list := make([]string, len(items))
			for i, item := range items {
				name, ok := item.(string)
				if !ok {
					return nil, invalid("foodItemIds must contain strings")
				}
				list[i] = name
			}
			values["food_item_ids"] = list
		default:
			return nil, invalid("foodItemIds must be an array")
		}
	}
	if d.Kind == "food" && values["food_amount_grams"] != nil {
		items, ok := values["food_item_ids"].([]string)
		if ok && len(items) != 1 {
			return nil, invalid("foodAmountGrams requires exactly one foodItemId")
		}
	}
	return values, nil
}

func nutritionRecordChange(d careSpec, op string, entity Object) (recordChange, error) {
	clock := entity["occurredAt"]
	if d.Kind == "food" && clock == nil {
		clock = text(entity["recordDate"]) + "T12:00:00.000Z"
	}
	occurred, err := asTime(clock)
	if err != nil {
		return recordChange{}, fmt.Errorf("invalid persisted %s clock: %w", d.Kind, err)
	}
	payload := Object{"id": entity["id"], "version": entity["version"]}
	if op == "delete" {
		payload["deleted"] = true
		return recordChange{Entity: entity, Payload: payload, Summary: "Deleted " + d.Kind + ": " + text(entity["id"]), OccurredAt: occurred}, nil
	}
	fields := []string{"recordDate", "mealType", "occurredAt", "foodItemIds", "foodAmountGrams", "portionDescription", "reaction"}
	name, label := text(entity["mealType"]), "Food"
	if d.Kind == "supplement" {
		fields = []string{"supplementName", "productId", "occurredAt", "amount", "dose", "unitName"}
		name, label = text(entity["supplementName"]), "Supplement"
	}
	for _, field := range fields {
		payload[field] = entity[field]
	}
	if op == "update" {
		label = "Updated " + d.Kind
	}
	return recordChange{Entity: entity, Payload: payload, Summary: label + ": " + name, OccurredAt: occurred}, nil
}

func (s *Server) mutateNutritionRecord(ctx context.Context, r *Request, d careSpec, op string) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil {
		return Result{}, err
	}
	id, version := r.Params["id"], int64(0)
	if op == "create" {
		id = newID()
	} else {
		raw := text(r.Body["baseVersion"])
		if op == "delete" {
			raw = r.HTTP.URL.Query().Get("baseVersion")
		}
		version, err = careBaseVersion(d, op, raw)
		if err != nil {
			return Result{}, err
		}
	}
	key := r.HTTP.Header.Get("Idempotency-Key")
	if key == "" {
		key = newID()
	}
	hash, digest, err := nutritionRecordHashes(d, op, scope, id, version, r.Body)
	if err != nil {
		return Result{}, err
	}
	values, err := nutritionRecordValues(d, r.Body, op == "create")
	if err != nil {
		return Result{}, err
	}
	entity, err := s.executeRecordCommand(ctx, r, recordCommand{
		Scope: scope, Kind: d.Kind, ID: id, Operation: op, Key: key, RequestHash: hash, PayloadHash: digest, BaseVersion: version,
		Apply: func(ctx context.Context, tx pgx.Tx, existing Object, nextVersion int64) (recordChange, error) {
			if d.Kind == "food" && op != "delete" {
				if err := validateFoodMeasuredAmount(ctx, tx, scope.FamilyID, op, values, existing); err != nil {
					return recordChange{}, err
				}
			}
			now := time.Now().UTC()
			values["version"], values["updated_at"] = nextVersion, now
			var row Object
			var err error
			if op == "create" {
				values["id"], values["family_id"], values["baby_id"], values["created_at"] = id, scope.FamilyID, scope.BabyID, now
				if d.Kind == "supplement" {
					values["recorded_by_user_id"] = r.Principal.UserID
				}
				row, err = insertObject(ctx, tx, d.Table, values)
			} else {
				if op == "delete" {
					values = Object{"version": nextVersion, "updated_at": now, "deleted_at": now}
				}
				row, err = updateColumns(ctx, tx, d.Table, id, values)
			}
			if err != nil {
				return recordChange{}, err
			}
			return nutritionRecordChange(d, op, nutritionRecordEntity(d, row))
		},
	})
	if err != nil {
		return Result{}, err
	}
	if op == "delete" {
		return ok(Object{"id": entity["id"], "deleted": true})
	}
	if op == "create" {
		return created(nutritionRecordDTO(d, entity))
	}
	return ok(nutritionRecordDTO(d, entity))
}

func asStringSlice(raw any) []string {
	switch value := raw.(type) {
	case []string:
		return value
	case []any:
		result := make([]string, len(value))
		for index, item := range value {
			result[index] = text(item)
		}
		return result
	default:
		return nil
	}
}

func requireFamilyFoodProfile(ctx context.Context, tx pgx.Tx, familyID, foodID string) error {
	var exists int
	err := tx.QueryRow(ctx, `SELECT 1 FROM food_library_items
		WHERE id=$1 AND family_id=$2 AND is_custom=true AND nutrients_json IS NOT NULL
		FOR SHARE`, foodID, familyID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalid("foodAmountGrams requires a custom family food with a per-100g nutrient profile")
	}
	return err
}

// validateFoodMeasuredAmount is shared by REST and native sync writes. It
// checks the family-owned profile in the same transaction that writes a
// measured food record, so the command path cannot bypass the REST guard.
func validateFoodMeasuredAmount(ctx context.Context, tx pgx.Tx, familyID, operation string, values, existing Object) error {
	if operation == "delete" {
		return nil
	}
	foodIDs := values["food_item_ids"]
	foodAmount := values["food_amount_grams"]
	validateProfile := operation == "create"
	if operation == "update" {
		if _, supplied := values["food_item_ids"]; !supplied && existing != nil {
			foodIDs = existing["food_item_ids"]
		}
		if _, supplied := values["food_amount_grams"]; !supplied && existing != nil {
			foodAmount = existing["food_amount_grams"]
		} else if foodAmount != nil {
			validateProfile = true
		}
		if _, supplied := values["food_item_ids"]; supplied && foodAmount != nil {
			oldIDs, newIDs := asStringSlice(existing["food_item_ids"]), asStringSlice(values["food_item_ids"])
			if len(oldIDs) != 1 || len(newIDs) != 1 || oldIDs[0] != newIDs[0] {
				validateProfile = true
			}
		}
	}
	if operation == "restore" && existing != nil {
		foodIDs = existing["food_item_ids"]
		foodAmount = existing["food_amount_grams"]
		// Restore exposes an already accepted historical record. The family may
		// have cleared its current nutrition profile since that record was made;
		// in that case keep the grams but let analysis report the profile unknown.
		validateProfile = false
	}
	if foodAmount == nil {
		return nil
	}
	ids := asStringSlice(foodIDs)
	if len(ids) != 1 {
		return invalid("foodAmountGrams requires exactly one foodItemId")
	}
	if validateProfile {
		return requireFamilyFoodProfile(ctx, tx, familyID, ids[0])
	}
	return nil
}

func foodItemCount(raw any) int {
	switch value := raw.(type) {
	case []any:
		return len(value)
	case []string:
		return len(value)
	default:
		return -1
	}
}
