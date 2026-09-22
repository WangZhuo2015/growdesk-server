package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type careField struct {
	Wire, Column, Type string
	Default            any
}
type careSpec struct {
	Kind, Table, OperationName, Clock string
	Fields                            []careField
}

// Field order also defines the reference JSON.stringify request-hash protocol.
// Never derive SQL identifiers from user-provided JSON keys.
var careSpecs = []careSpec{
	{"feeding", "feeding_records", "FeedingRecord", "occurred_at", []careField{
		{"feedingType", "feeding_type", "text", nil}, {"occurredAt", "occurred_at", "time", nil},
		{"amountMl", "amount_ml", "decimal", nil}, {"leftMinutes", "left_minutes", "int", nil}, {"rightMinutes", "right_minutes", "int", nil},
		{"formulaProductId", "formula_product_id", "text", nil}, {"spitUp", "spit_up", "booltext", false}, {"notes", "notes", "text", nil},
	}},
	{"sleep", "sleep_records", "SleepRecord", "started_at", []careField{
		{"sleepType", "sleep_type", "text", nil}, {"startedAt", "started_at", "time", nil}, {"endedAt", "ended_at", "time", nil},
		{"nightWakingCount", "night_waking_count", "int", int64(0)}, {"notes", "notes", "text", nil},
	}},
	{"diaper", "diaper_records", "DiaperRecord", "occurred_at", []careField{
		{"diaperType", "diaper_type", "text", nil}, {"occurredAt", "occurred_at", "time", nil},
		{"poopColor", "poop_color", "text", nil}, {"poopConsistency", "poop_consistency", "text", nil}, {"notes", "notes", "text", nil},
	}},
}

func (s *Server) registerCare() {
	for _, spec := range careSpecs {
		d := spec
		s.Register("list"+d.OperationName+"s", false, func(ctx context.Context, r *Request) (Result, error) { return s.listCare(ctx, r, d) })
		s.Register("get"+d.OperationName, false, func(ctx context.Context, r *Request) (Result, error) { return s.getCare(ctx, r, d) })
		for _, operation := range []string{"create", "update", "delete"} {
			op := operation
			s.Register(op+d.OperationName, false, func(ctx context.Context, r *Request) (Result, error) { return s.mutateCare(ctx, r, d, op) })
		}
	}
	s.Register("getTimeline", false, s.getTimeline)
}

func parseWireVersion(value string) (int64, error) {
	if value == "" || value[0] == '0' {
		return 0, apiError(400, "INVALID_BASE_VERSION", "baseVersion must be a positive integer string")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, apiError(400, "INVALID_BASE_VERSION", "baseVersion must be a positive integer string")
		}
	}
	version, err := strconv.ParseInt(value, 10, 32)
	if err != nil || version < 1 {
		return 0, apiError(400, "INVALID_BASE_VERSION", "baseVersion is outside the persisted version range")
	}
	return version, nil
}

func normalizedCareValue(field careField, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	if field.Type == "time" {
		t, err := asTime(value)
		if err != nil {
			return nil, invalid("Invalid " + field.Wire)
		}
		return iso(t), nil
	}
	// JSON.parse/JSON.stringify normalize numeric tokens (1.0 becomes 1).
	// Retain decimal *strings*: the reference hash distinguishes "1.0" and 1.
	if n, ok := value.(json.Number); ok {
		v, err := n.Float64()
		if err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
			return nil, invalid("Invalid number")
		}
		return v, nil
	}
	return value, nil
}

func careRequestHash(d careSpec, op string, scope Scope, id string, version int64, body Object) (string, error) {
	pairs := []any{"operation", op, "entityType", d.Kind}
	if op != "create" {
		pairs = append(pairs, "id", id)
	}
	if op == "update" || (op == "delete" && d.Kind != "feeding") {
		pairs = append(pairs, "baseVersion", version)
	}
	pairs = append(pairs, "familyId", scope.FamilyID, "babyId", scope.BabyID)
	if op == "delete" {
		if d.Kind == "feeding" {
			pairs = append(pairs, "baseVersion", version)
		}
		return orderedHash(pairs...)
	}
	for _, field := range d.Fields {
		value, present := body[field.Wire]
		if !present && op == "update" {
			continue
		}
		if value == nil && op == "create" {
			value = field.Default
		}
		value, err := normalizedCareValue(field, value)
		if err != nil {
			return "", err
		}
		pairs = append(pairs, field.Wire, value)
	}
	return orderedHash(pairs...)
}

func careValues(d careSpec, body Object, create bool) (Object, error) {
	values := Object{}
	for _, field := range d.Fields {
		value, present := body[field.Wire]
		if !present && !create {
			continue
		}
		if value == nil && create {
			value = field.Default
		}
		if value != nil {
			switch field.Type {
			case "time":
				t, err := asTime(value)
				if err != nil {
					return nil, invalid("Invalid " + field.Wire)
				}
				value = t.Truncate(time.Millisecond)
			case "decimal":
				var n pgtype.Numeric
				if err := n.Scan(text(value)); err != nil {
					return nil, invalid("Invalid decimal " + field.Wire)
				}
				value = n
			case "int":
				value = integer(value)
			case "booltext":
				if boolean(value) {
					value = "true"
				} else {
					value = "false"
				}
			}
		}
		values[field.Column] = value
	}
	if create && d.Kind == "feeding" {
		values["duration_minutes"] = nil
	}
	return values, nil
}

func camelColumn(column string) string {
	parts := strings.Split(column, "_")
	for i := 1; i < len(parts); i++ {
		if len(parts[i]) > 0 {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}
func careEntity(d careSpec, row Object) Object {
	result := Object{}
	for key, value := range row {
		if strings.HasSuffix(key, "_at") {
			value = isoValue(value)
		}
		result[camelColumn(key)] = value
	}
	if d.Kind == "feeding" {
		result["amountMl"] = decimalValue(row["amount_ml"])
	}
	return result
}
func careDTO(d careSpec, entity Object) Object {
	result := Object{}
	for _, field := range d.Fields {
		value := entity[field.Wire]
		if field.Type == "booltext" {
			value = text(value) == "true" || text(value) == "1" || text(value) == "mild"
		}
		result[field.Wire] = value
	}
	for _, key := range []string{"id", "babyId", "familyId", "source", "sourceAgent", "recordedByUserId", "createdAt", "updatedAt"} {
		result[key] = entity[key]
	}
	result["version"] = text(entity["version"])
	switch d.Kind {
	case "feeding":
		v := text(result["feedingType"])
		if v != "breast" && v != "bottle" && v != "formula" && v != "mixed" {
			result["feedingType"] = "formula"
		}
	case "sleep":
		v := text(result["sleepType"])
		if v != "nap" && v != "night" {
			result["sleepType"] = "nap"
		}
	case "diaper":
		v := text(result["diaperType"])
		if v != "pee" && v != "poop" && v != "both" {
			result["diaperType"] = "both"
		}
	}
	return result
}

func pageLimit(r *Request) int {
	limit := 50
	if raw := r.HTTP.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	return limit
}
func decodeCareCursor(raw string) (time.Time, string, bool) {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
	if err != nil {
		return time.Time{}, "", false
	}
	parts := strings.Split(string(b), "|")
	if len(parts) < 2 || parts[1] == "" {
		return time.Time{}, "", false
	}
	t, err := asTime(parts[0])
	return t, parts[1], err == nil
}
func encodeCareCursor(t any, id any) string {
	return base64.RawURLEncoding.EncodeToString([]byte(text(isoValue(t)) + "|" + text(id)))
}

func (s *Server) listCare(ctx context.Context, r *Request, d careSpec) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], false)
	if err != nil {
		return Result{}, err
	}
	args := []any{scope.FamilyID, scope.BabyID}
	where := "family_id=$1 AND baby_id=$2 AND deleted_at IS NULL"
	clock := pgx.Identifier{d.Clock}.Sanitize()
	if t, id, valid := decodeCareCursor(r.HTTP.URL.Query().Get("cursor")); valid {
		args = append(args, t, id)
		where += " AND (" + clock + ",id)<($3,$4)"
	}
	limit := pageLimit(r)
	args = append(args, limit+1)
	rows, err := many(ctx, s.DB, "SELECT to_jsonb(t) FROM "+pgx.Identifier{d.Table}.Sanitize()+" t WHERE "+where+" ORDER BY "+clock+" DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return Result{}, err
	}
	var next any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = encodeCareCursor(last[d.Clock], last["id"])
	}
	records := make([]Object, 0, len(rows))
	for _, row := range rows {
		records = append(records, careDTO(d, careEntity(d, row)))
	}
	return Result{Status: 200, Body: page(records, next)}, nil
}
func (s *Server) getCare(ctx context.Context, r *Request, d careSpec) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], false)
	if err != nil {
		return Result{}, err
	}
	row, err := one(ctx, s.DB, "SELECT to_jsonb(t) FROM "+pgx.Identifier{d.Table}.Sanitize()+" t WHERE family_id=$1 AND baby_id=$2 AND id=$3 AND deleted_at IS NULL", scope.FamilyID, scope.BabyID, r.Params["id"])
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound(d.Kind+"_record", r.Params["id"])
	}
	if err != nil {
		return Result{}, err
	}
	return ok(careDTO(d, careEntity(d, row)))
}

func reusedKey(key string) error {
	return apiError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key reused with different payload for command: "+key)
}

func legacyCareReplay(ctx context.Context, q Querier, d careSpec, scope Scope, key string, values Object) (Object, error) {
	rows, err := many(ctx, q, "SELECT to_jsonb(t) FROM "+pgx.Identifier{d.Table}.Sanitize()+" t WHERE family_id=$1 AND baby_id=$2 AND legacy_client_id=$3 ORDER BY id LIMIT 2", scope.FamilyID, scope.BabyID, key)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	for _, row := range rows {
		if row["deleted_at"] != nil {
			return nil, apiError(409, "LEGACY_IDEMPOTENCY_GONE", "The legacy idempotency key refers to a deleted record: "+key)
		}
	}
	if len(rows) != 1 {
		return nil, reusedKey(key)
	}
	row := rows[0]
	for column, expected := range values {
		actual := row[column]
		switch value := expected.(type) {
		case time.Time:
			expected = iso(value)
			actual = isoValue(actual)
		case pgtype.Numeric:
			bytes, err := value.MarshalJSON()
			if err != nil {
				return nil, err
			}
			expected = decimalValue(json.Number(string(bytes)))
			actual = decimalValue(actual)
		}
		if (actual == nil) != (expected == nil) || (actual != nil && text(actual) != text(expected)) {
			return nil, reusedKey(key)
		}
	}
	return careEntity(d, row), nil
}

func validateCareMutation(ctx context.Context, q Querier, d careSpec, scope Scope, id, op string, body, values, existing Object) error {
	if product := text(body["formulaProductId"]); product != "" && d.Kind == "feeding" {
		var productID string
		err := q.QueryRow(ctx, `SELECT id FROM formula_products WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR SHARE`, product, scope.FamilyID).Scan(&productID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiError(400, "FORMULA_PRODUCT_NOT_FOUND", "Formula product does not belong to family or was deleted")
		}
		if err != nil {
			return err
		}
	}
	if d.Kind != "sleep" || op == "delete" {
		return nil
	}
	started, ended := values["started_at"], values["ended_at"]
	if existing != nil {
		if _, ok := values["started_at"]; !ok {
			started = existing["started_at"]
		}
		if _, ok := values["ended_at"]; !ok {
			ended = existing["ended_at"]
		}
	}
	st, err := asTime(started)
	if err != nil {
		return invalid("Invalid startedAt")
	}
	if ended != nil {
		en, err := asTime(ended)
		if err != nil {
			return invalid("Invalid endedAt")
		}
		if en.Before(st) {
			return apiError(400, "INVALID_SLEEP_INTERVAL", "endedAt cannot be earlier than startedAt")
		}
	}
	if ended == nil && (op == "create" || existing["ended_at"] != nil) {
		var otherID string
		err = q.QueryRow(ctx, `SELECT id FROM sleep_records WHERE baby_id=$1 AND id<>$2 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1`, scope.BabyID, id).Scan(&otherID)
		if err == nil {
			return apiError(409, "ACTIVE_SLEEP_EXISTS", "An active sleep record already exists for baby")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	return nil
}

func careEvent(d careSpec, op string, entity Object) (Object, string, any) {
	payload := Object{"id": entity["id"], "version": entity["version"]}
	clock := entity[camelColumn(d.Clock)]
	if op == "delete" {
		payload["deleted"] = true
		return payload, "Deleted " + d.Kind + ": " + text(entity["id"]), clock
	}
	prefix := strings.ToUpper(d.Kind[:1]) + d.Kind[1:] + ": "
	if op == "update" {
		prefix = "Updated " + d.Kind + ": "
	}
	switch d.Kind {
	case "feeding":
		for _, key := range []string{"feedingType", "occurredAt", "amountMl"} {
			payload[key] = entity[key]
		}
		summary := prefix + text(entity["feedingType"])
		if entity["amountMl"] != nil && text(entity["amountMl"]) != "" {
			summary += " " + text(entity["amountMl"]) + "ml"
		}
		return payload, summary, clock
	case "sleep":
		for _, key := range []string{"sleepType", "startedAt", "endedAt", "nightWakingCount"} {
			payload[key] = entity[key]
		}
		summary := prefix + text(entity["sleepType"])
		if entity["endedAt"] != nil {
			summary += " (finished)"
		} else {
			summary += " (in progress)"
		}
		return payload, summary, clock
	default:
		for _, key := range []string{"diaperType", "occurredAt", "poopColor", "poopConsistency"} {
			payload[key] = entity[key]
		}
		return payload, prefix + text(entity["diaperType"]), clock
	}
}

// The record, timeline projection, family cursor/change and receipt commit as
// one unit. There is no Redis/cache/local-file success fallback.
func (s *Server) mutateCare(ctx context.Context, r *Request, d careSpec, op string) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], true)
	if err != nil {
		return Result{}, err
	}
	id := r.Params["id"]
	if op == "create" {
		id = newID()
	}
	var version int64
	if op != "create" {
		raw := text(r.Body["baseVersion"])
		if op == "delete" {
			raw = r.HTTP.URL.Query().Get("baseVersion")
		}
		version, err = parseWireVersion(raw)
		if err != nil {
			return Result{}, err
		}
	}
	key := r.HTTP.Header.Get("Idempotency-Key")
	if key == "" {
		key = newID()
	}
	requestHash, err := careRequestHash(d, op, scope, id, version, r.Body)
	if err != nil {
		return Result{}, err
	}
	values, err := careValues(d, r.Body, op == "create")
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, scope.FamilyID)
	if err != nil {
		return Result{}, err
	}
	current, err := babyScope(ctx, tx, r.Principal.UserID, scope.BabyID, true)
	if err != nil {
		return Result{}, err
	}
	if current.FamilyID != scope.FamilyID {
		return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Baby scope changed")
	}
	// Validate foreign references before replay, as the reference service does.
	if d.Kind == "feeding" {
		if err = validateCareMutation(ctx, tx, d, scope, id, op, r.Body, values, nil); err != nil {
			return Result{}, err
		}
	}
	if op == "create" {
		entity, err := legacyCareReplay(ctx, tx, d, scope, key, values)
		if err != nil {
			return Result{}, err
		}
		if entity != nil {
			if err = tx.Commit(ctx); err != nil {
				return Result{}, err
			}
			return created(careDTO(d, entity))
		}
	}
	receipt, err := one(ctx, tx, `SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`, r.Principal.UserID, scope.FamilyID, key)
	if err == nil {
		if strings.TrimSpace(text(receipt["request_hash"])) != requestHash {
			return Result{}, reusedKey(key)
		}
		entity := obj(receipt["response_body"])
		if entity == nil {
			return Result{}, apiError(500, "INVALID_RECEIPT", "Stored receipt has no record")
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return careMutationResult(d, op, entity)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	var existing Object
	if op != "create" {
		existing, err = one(ctx, tx, "SELECT to_jsonb(t) FROM "+pgx.Identifier{d.Table}.Sanitize()+" t WHERE family_id=$1 AND baby_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE", scope.FamilyID, scope.BabyID, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, notFound(d.Kind, id)
		}
		if err != nil {
			return Result{}, err
		}
		if integer(existing["version"]) != version {
			return Result{}, apiError(409, "CONCURRENCY_CONFLICT", fmt.Sprintf("Version conflict on %s:%s - baseVersion %d != current %s", d.Kind, id, version, text(existing["version"])))
		}
	}
	if d.Kind != "feeding" {
		if err = validateCareMutation(ctx, tx, d, scope, id, op, r.Body, values, existing); err != nil {
			return Result{}, err
		}
	}
	if version == math.MaxInt32 || cursor == math.MaxInt64 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Persisted version range exhausted")
	}
	version++
	now := time.Now().UTC()
	values["version"] = version
	values["updated_at"] = now
	var row Object
	if op == "create" {
		values["id"], values["family_id"], values["baby_id"] = id, scope.FamilyID, scope.BabyID
		values["created_at"], values["recorded_by_user_id"], values["source_agent"] = now, r.Principal.UserID, r.Body["sourceAgent"]
		source := text(r.Body["source"])
		if source == "" {
			source = "ui_manual"
		}
		values["source"] = source
		row, err = insertObject(ctx, tx, d.Table, values)
	} else {
		if op == "delete" {
			values = Object{"version": version, "updated_at": now, "deleted_at": now}
		}
		row, err = updateColumns(ctx, tx, d.Table, id, values)
	}
	if err != nil {
		return Result{}, err
	}
	entity := careEntity(d, row)
	payload, summary, clock := careEvent(d, op, entity)
	eventAt, err := asTime(clock)
	if err != nil {
		return Result{}, err
	}
	rawPayload, err := jsonText(payload)
	if err != nil {
		return Result{}, err
	}
	var deleted any
	if op == "delete" {
		deleted = now
	}
	_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,version,deleted_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$11)
        ON CONFLICT(family_id,baby_id,entity_type,entity_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,summary=EXCLUDED.summary,
        details=EXCLUDED.details,version=EXCLUDED.version,deleted_at=EXCLUDED.deleted_at,updated_at=EXCLUDED.updated_at`, newID(), scope.FamilyID, scope.BabyID, d.Kind, id, eventAt, summary, rawPayload, version, deleted, now)
	if err != nil {
		return Result{}, err
	}
	cursor++
	if _, err = tx.Exec(ctx, `UPDATE family_sync_states SET cursor=$2,updated_at=$3 WHERE family_id=$1`, scope.FamilyID, cursor, now); err != nil {
		return Result{}, err
	}
	change := copyObject(payload)
	change["babyId"] = scope.BabyID
	changeJSON, err := jsonText(change)
	if err != nil {
		return Result{}, err
	}
	changeOp := "upsert"
	if op == "delete" {
		changeOp = "delete"
	}
	_, err = tx.Exec(ctx, `INSERT INTO family_changes(family_id,cursor,entity_type,entity_id,version,op,payload,schema_version,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8)`, scope.FamilyID, cursor, d.Kind, id, version, changeOp, changeJSON, now)
	if err != nil {
		return Result{}, err
	}
	responseJSON, err := jsonText(entity)
	if err != nil {
		return Result{}, err
	}
	summaryJSON, err := jsonText(Object{"summary": summary, "familyCursor": strconv.FormatInt(cursor, 10), "version": version})
	if err != nil {
		return Result{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,result_summary,response_body,completed_at)
        VALUES($1,$2,$3,$4,200,$5::jsonb,$6::jsonb,$7)`, r.Principal.UserID, scope.FamilyID, key, requestHash, summaryJSON, responseJSON, now)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return careMutationResult(d, op, entity)
}

func careMutationResult(d careSpec, op string, entity Object) (Result, error) {
	if op == "delete" {
		return ok(Object{"id": entity["id"], "deleted": true})
	}
	if op == "create" {
		return created(careDTO(d, entity))
	}
	return ok(careDTO(d, entity))
}

func (s *Server) getTimeline(ctx context.Context, r *Request) (Result, error) {
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, r.Params["babyId"], false)
	if err != nil {
		return Result{}, err
	}
	args := []any{scope.FamilyID, scope.BabyID}
	where := "family_id=$1 AND baby_id=$2 AND deleted_at IS NULL"
	if kind := r.HTTP.URL.Query().Get("entityType"); kind != "" {
		args = append(args, kind)
		where += " AND entity_type=$" + strconv.Itoa(len(args))
	}
	if t, id, valid := decodeCareCursor(r.HTTP.URL.Query().Get("cursor")); valid {
		args = append(args, t, id)
		where += fmt.Sprintf(" AND (occurred_at,id)<($%d,$%d)", len(args)-1, len(args))
	}
	limit := pageLimit(r)
	args = append(args, limit+1)
	rows, err := many(ctx, s.DB, "SELECT to_jsonb(t) FROM timeline_entries t WHERE "+where+" ORDER BY occurred_at DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return Result{}, err
	}
	var next any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = encodeCareCursor(last["occurred_at"], last["id"])
	}
	result := make([]Object, 0, len(rows))
	for _, row := range rows {
		result = append(result, Object{"id": row["id"], "babyId": row["baby_id"], "entityType": row["entity_type"], "entityId": row["entity_id"], "occurredAt": isoValue(row["occurred_at"]), "summary": row["summary"], "version": text(row["version"])})
	}
	return Result{Status: 200, Body: page(result, next)}, nil
}
