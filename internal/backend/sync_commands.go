package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// jsOrderedJSON preserves property insertion order (and JS array-index key
// ordering) for the existing cross-runtime sync receipt protocol. It accepts
// only bounded JSON, normalizes number spellings, and never executes JS.
func jsOrderedJSON(raw []byte) ([]byte, error) {
	if len(raw) > 1024*1024 {
		return nil, invalid("JSON input exceeds the supported budget")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	order, err := readJSONOrder(decoder, 0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, invalid("Expected one JSON value")
	}
	var value any
	if err = decodeJSON(raw, &value); err != nil {
		return nil, err
	}
	return orderedDocumentJSON(value, order)
}

func commandSpec(kind string) (careSpec, error) {
	for _, d := range careSpecs {
		if kind == d.Kind {
			return d, nil
		}
	}
	for _, d := range nutritionRecordSpecs {
		if kind == d.Kind {
			return d, nil
		}
	}
	if kind == "growth" {
		return careSpec{Kind: "growth", Table: "growth_measurements", OperationName: "GrowthMeasurement"}, nil
	}
	return careSpec{}, apiError(422, "UNSUPPORTED_ENTITY", "Unsupported record command")
}
func commandKind(wire string) string {
	switch wire {
	case "foodLog":
		return "food"
	case "supplementRecord":
		return "supplement"
	case "growthMeasurement":
		return "growth"
	}
	return wire
}

// REST, sync and AI writes share schema validation and domain invariants.
// Unknown client keys cannot become SQL columns; foreign references are
// verified under the same family lock as the mutation.
func (s *Server) prepareRecordCommand(principal Principal, scope Scope, kind, id, operation, key, hash, digest string, version int64, body Object, source string) (recordCommand, error) {
	d, err := commandSpec(kind)
	if err != nil {
		return recordCommand{}, err
	}
	body = copyObject(body)
	if operation != "delete" && operation != "restore" {
		schemaID := "create" + d.OperationName
		if operation == "update" {
			schemaID = "update" + d.OperationName
			body["baseVersion"] = strconv.FormatInt(version, 10)
		}
		route := s.Contract.ByID[schemaID]
		if route == nil || route.Operation.RequestBody == nil {
			return recordCommand{}, errors.New("missing record input contract")
		}
		schema := route.Operation.RequestBody.Value.Content.Get("application/json").Schema.Value
		if err = normalizeBody(schema, body); err != nil {
			return recordCommand{}, err
		}
		if err = schema.VisitJSON(schemaJSONValue(body), wireFormats...); err != nil {
			return recordCommand{}, apiError(400, "FST_ERR_VALIDATION", "Record payload violates its domain contract")
		}
	}
	var values Object
	if kind == "growth" {
		values, err = growthValues(body, operation == "create")
	} else if kind == "food" || kind == "supplement" {
		values, err = nutritionRecordValues(d, body, operation == "create")
	} else {
		values, err = careValues(d, body, operation == "create")
	}
	if err != nil {
		return recordCommand{}, err
	}
	command := recordCommand{Scope: scope, Kind: kind, ID: id, Operation: operation, Key: key, RequestHash: hash, PayloadHash: digest, BaseVersion: version}
	command.Apply = func(ctx context.Context, tx pgx.Tx, existing Object, next int64) (recordChange, error) {
		if operation == "restore" {
			if existing == nil || existing["deleted_at"] == nil {
				return recordChange{}, apiError(409, "CONCURRENCY_CONFLICT", "Only a deleted record can be restored")
			}
			values = Object{"deleted_at": nil}
			// An empty update must not circumvent active sleep or attachment
			// constraints when a tombstone is made visible again.
			if kind == "sleep" {
				if err := validateCareMutation(ctx, tx, d, scope, id, "create", body, existing, nil); err != nil {
					return recordChange{}, err
				}
			}
		}
		if operation != "delete" {
			if kind == "growth" {
				attachment, provided := values["attachment_id"]
				if !provided && existing != nil {
					attachment = existing["attachment_id"]
				}
				if err := validateGrowthAttachment(ctx, tx, attachment, scope); err != nil {
					return recordChange{}, err
				}
			} else if kind == "feeding" || kind == "sleep" || kind == "diaper" {
				checkBody := body
				if operation == "restore" && kind == "feeding" {
					checkBody = Object{"formulaProductId": existing["formula_product_id"]}
				}
				if err := validateCareMutation(ctx, tx, d, scope, id, operation, checkBody, values, existing); err != nil {
					return recordChange{}, err
				}
			}
			if kind == "supplement" {
				product, present := values["product_id"]
				if !present && existing != nil {
					product = existing["product_id"]
				}
				if product != nil {
					var found string
					err := tx.QueryRow(ctx, `SELECT id FROM supplement_products WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR SHARE`, text(product), scope.FamilyID).Scan(&found)
					if errors.Is(err, pgx.ErrNoRows) {
						return recordChange{}, apiError(400, "SUPPLEMENT_PRODUCT_NOT_FOUND", "Supplement product does not belong to the family")
					}
					if err != nil {
						return recordChange{}, err
					}
				}
			}
		}
		now := time.Now().UTC()
		values = copyObject(values)
		values["updated_at"], values["version"] = now, next
		var row Object
		var e error
		if operation == "create" {
			values["id"], values["family_id"], values["baby_id"], values["created_at"] = id, scope.FamilyID, scope.BabyID, now
			if kind == "feeding" || kind == "sleep" || kind == "diaper" || kind == "supplement" {
				values["recorded_by_user_id"] = principal.UserID
			}
			if kind != "growth" {
				values["source"] = source
				values["source_agent"] = body["sourceAgent"]
			}
			row, e = insertObject(ctx, tx, d.Table, values)
		} else {
			if operation == "delete" {
				values = Object{"deleted_at": now, "updated_at": now, "version": next}
			}
			row, e = updateColumns(ctx, tx, d.Table, id, values)
		}
		if e != nil {
			return recordChange{}, e
		}
		if kind == "growth" {
			entity, e := growthEntity(row)
			if e != nil {
				return recordChange{}, e
			}
			return growthChange(entity, operation)
		}
		if kind == "food" || kind == "supplement" {
			return nutritionRecordChange(d, operation, nutritionRecordEntity(d, row))
		}
		entity := careEntity(d, row)
		payload, summary, clock := careEvent(d, operation, entity)
		occurred, e := asTime(clock)
		return recordChange{Entity: entity, Payload: payload, Summary: summary, OccurredAt: occurred}, e
	}
	return command, nil
}

func syncPayload(kind, op string, payload Object, created string) Object {
	body := copyObject(payload)
	alias := func(target string, names ...string) {
		for _, name := range append(names, target) {
			if value, ok := payload[name]; ok && value != nil && text(value) != "" {
				body[target] = value
				return
			}
		}
	}
	switch kind {
	case "feeding":
		alias("feedingType", "type")
		alias("occurredAt", "timestamp")
	case "sleep":
		alias("sleepType", "type")
		alias("startedAt", "startTime")
		alias("endedAt", "endTime")
	case "diaper":
		alias("diaperType", "type")
		alias("occurredAt", "timestamp")
	case "food":
		alias("recordDate", "date")
	case "supplement":
		alias("supplementName", "name")
		alias("occurredAt", "timestamp")
	case "growth":
		alias("measurementDate", "date")
	}
	if op == "create" {
		defaults := Object{"occurredAt": created}
		switch kind {
		case "feeding":
			defaults["feedingType"] = "formula"
		case "sleep":
			defaults = Object{"sleepType": "nap", "startedAt": created, "nightWakingCount": int64(0)}
		case "diaper":
			defaults["diaperType"] = "both"
		case "food":
			defaults = Object{"recordDate": created[:10], "mealType": "lunch", "foodItemIds": []any{}}
		case "supplement":
			defaults["supplementName"] = "Supplement"
		case "growth":
			defaults = Object{"measurementDate": created[:10]}
		}
		for key, value := range defaults {
			if body[key] == nil || text(body[key]) == "" {
				if _, exists := body[key]; !exists {
					body[key] = value
				}
			}
		}
	}
	// Legacy sync accepts decimal numbers while the canonical REST boundary
	// uses decimal strings. Normalize only declared decimal fields here.
	for _, key := range []string{"amountMl", "weightKg", "heightCm", "headCircumferenceCm", "dose"} {
		switch v := body[key].(type) {
		case json.Number:
			body[key] = v.String()
		case float64:
			body[key] = strconv.FormatFloat(v, 'f', -1, 64)
		}
	}
	return body
}
func (s *Server) registerSyncCommands() {
	s.Register("executeSyncCommands", false, s.executeNativeSyncCommands)
}
func (s *Server) executeNativeSyncCommands(ctx context.Context, r *Request) (Result, error) {
	items, validBatch := r.Body["commands"].([]any)
	if !validBatch || len(items) == 0 || len(items) > 50 {
		return Result{}, invalid("Invalid command batch")
	}
	seen := map[string]bool{}
	for _, item := range items {
		id := text(obj(item)["entityId"])
		if seen[id] {
			return Result{}, apiError(422, "BATCH_DEPENDENCY_UNRESOLVED", "Multiple commands cannot target one entity in a batch")
		}
		seen[id] = true
	}
	var raw struct {
		Commands []struct {
			Payload json.RawMessage `json:"payload"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(r.RawBody, &raw); err != nil || len(raw.Commands) != len(items) {
		return Result{}, invalid("Missing command input")
	}
	results := make([]Object, 0, len(items))
	for i, item := range items {
		cmd := obj(item)
		id, key := text(cmd["entityId"]), text(cmd["commandId"])
		result := Object{"commandId": key, "entityId": id, "version": nil, "familyCursor": nil}
		outcome, err := s.executeNativeSyncCommand(ctx, r, cmd, raw.Commands[i].Payload)
		if err == nil {
			result["status"] = "applied"
			if outcome.Replayed {
				result["status"] = "replayed"
			}
			result["version"] = strconv.FormatInt(outcome.Version, 10)
			result["familyCursor"] = outcome.Cursor
		} else {
			e := normalizedError(err)
			result["status"] = "error"
			result["error"] = Object{"code": e.Code, "message": e.Message}
			if e.Code == "CONCURRENCY_CONFLICT" {
				// Authorization is rechecked before exposing even a version.
				scope, scopeErr := babyScope(ctx, s.DB, r.Principal.UserID, text(cmd["babyId"]), false)
				if scopeErr == nil && scope.FamilyID == text(cmd["familyId"]) {
					d, specErr := commandSpec(commandKind(text(cmd["entityType"])))
					if specErr == nil {
						var current int64
						if qerr := s.DB.QueryRow(ctx, "SELECT version FROM "+pgx.Identifier{d.Table}.Sanitize()+" WHERE id=$1 AND family_id=$2 AND baby_id=$3", id, scope.FamilyID, scope.BabyID).Scan(&current); qerr == nil {
							delete(result, "error")
							result["status"] = "conflict"
							result["conflict"] = Object{"currentVersion": strconv.FormatInt(current, 10), "currentEntity": Object{}, "reason": e.Message}
						}
					}
				}
			}
		}
		results = append(results, result)
		if ctx.Err() != nil {
			break
		}
	}
	// Do not silently omit unprocessed commands after request cancellation.
	if len(results) != len(items) {
		return Result{}, ctx.Err()
	}
	return ok(Object{"results": results})
}
func (s *Server) executeNativeSyncCommand(ctx context.Context, r *Request, cmd Object, raw json.RawMessage) (recordOutcome, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, text(cmd["babyId"]), true)
	if err != nil {
		return recordOutcome{}, err
	}
	if scope.FamilyID != text(cmd["familyId"]) {
		return recordOutcome{}, apiError(403, "BABY_SCOPE_MISMATCH", "Command family does not own baby")
	}
	operation, kind := text(cmd["operation"]), commandKind(text(cmd["entityType"]))
	var hashVersion any
	version := int64(1)
	if cmd["baseVersion"] != nil {
		version, err = syncPosition(text(cmd["baseVersion"]))
		if err != nil {
			return recordOutcome{}, err
		}
		hashVersion = version
	}
	encoded, err := jsOrderedJSON(raw)
	if err != nil {
		return recordOutcome{}, err
	}
	hash, err := orderedHash("operation", operation, "entityType", cmd["entityType"], "id", cmd["entityId"], "familyId", scope.FamilyID, "babyId", scope.BabyID, "baseVersion", hashVersion, "payload", json.RawMessage(encoded))
	if err != nil {
		return recordOutcome{}, err
	}
	digest, err := snapshotHash(cmd)
	if err != nil {
		return recordOutcome{}, err
	}
	body := syncPayload(kind, operation, obj(cmd["payload"]), text(cmd["clientCreatedAt"]))
	command, err := s.prepareRecordCommand(r.Principal, scope, kind, text(cmd["entityId"]), operation, text(cmd["commandId"]), hash, digest, version, body, "manual")
	if err != nil {
		return recordOutcome{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return recordOutcome{}, err
	}
	defer rollback(tx)
	outcome, err := s.executeRecordCommandTx(ctx, tx, r, command)
	if err != nil {
		return recordOutcome{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return recordOutcome{}, err
	}
	return outcome, nil
}

// Used by native extensions that still require the ordinary API credential.
func syntheticNativeRequest(principal Principal, body Object) *Request {
	return &Request{Principal: principal, Body: body, Params: map[string]string{}, HTTP: &http.Request{Header: make(http.Header)}}
}
