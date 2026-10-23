package backend

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	passportMaxCardFields = 10
	passportMaxCardLabel  = 50
	passportMaxCardValue  = 200
	passportMaxCardUnit   = 20
	passportMaxCardTitle  = 50
	passportMaxCardFooter = 50
)

type PassportCardField struct {
	Label    string `json:"label"`
	Value    string `json:"value"`
	Unit     string `json:"unit,omitempty"`
	Emphasis bool   `json:"emphasis,omitempty"`
}

type PassportCard struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Kind          string              `json:"kind"`
	EntityType    string              `json:"entityType"`
	Title         string              `json:"title"`
	Status        string              `json:"status"`
	Fields        []PassportCardField `json:"fields"`
	Footer        string              `json:"footer,omitempty"`
}

type PassportConfirmationMeta struct {
	PlanHash  string   `json:"planHash"`
	ActionIDs []string `json:"actionIds"`
	ExpiresAt string   `json:"expiresAt"`
}

// normalizeValidatePassportAction is the single boundary used before a
// proposal can be shown and again before it can be committed. It canonicalizes
// legacy wire entity names, strips server-owned scope/source keys, validates
// the real create contract, and rejects any payload the display cannot show
// faithfully. prepareRecordCommand only prepares an Apply closure here; it
// performs no database access until that closure is called.
func (s *Server) normalizeValidatePassportAction(action nativeAIAction) (nativeAIAction, PassportCard, error) {
	if !actionUUID.MatchString(action.ActionID) {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}
	if action.Operation != "create" {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}
	if strings.TrimSpace(action.Summary) == "" || action.Payload == nil {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}

	kind := commandKind(strings.TrimSpace(action.EntityType))
	d, err := commandSpec(kind)
	if err != nil {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}
	if s == nil || s.Contract == nil {
		return nativeAIAction{}, PassportCard{}, providerFailure("PASSPORT_CONTRACT_UNAVAILABLE", "The record contract is unavailable", false)
	}
	route := s.Contract.ByID["create"+d.OperationName]
	if route == nil || route.Operation == nil || route.Operation.RequestBody == nil || route.Operation.RequestBody.Value == nil {
		return nativeAIAction{}, PassportCard{}, providerFailure("PASSPORT_CONTRACT_UNAVAILABLE", "The record contract is unavailable", false)
	}
	media := route.Operation.RequestBody.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil {
		return nativeAIAction{}, PassportCard{}, providerFailure("PASSPORT_CONTRACT_UNAVAILABLE", "The record contract is unavailable", false)
	}
	schema := media.Schema.Value

	// Keep only request-contract keys. These server-owned fields are never
	// accepted from the model, even though some record response schemas expose
	// them. Unknown properties are omitted by the same contract rules used by
	// the record command path.
	clean := Object{}
	for key, value := range action.Payload {
		if _, allowed := schema.Properties[key]; !allowed {
			continue
		}
		if isPassportServerOwnedKey(key) {
			continue
		}
		clean[key] = value
	}
	for _, key := range passportDecimalFields(kind) {
		value, exists := clean[key]
		if !exists || value == nil {
			continue
		}
		decimal, conversionErr := passportDecimalString(value)
		if conversionErr != nil {
			return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
		}
		clean[key] = decimal
	}

	// Required schema fields, enum values, formats, and domain value shapes are
	// checked with the same contract and record preparation code as real writes.
	// Keep a separate copy so schema defaults do not become guessed card data.
	contractBody := copyObject(clean)
	if err = normalizeBody(schema, contractBody); err != nil {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}
	if err = schema.VisitJSON(schemaJSONValue(contractBody), wireFormats...); err != nil {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}
	canonical := action
	canonical.EntityType = kind
	canonical.Payload = clean
	if _, err = s.prepareRecordCommand(Principal{}, Scope{}, kind,
		canonical.ActionID, "create", "", "", "", 0,
		contractBody, "passport"); err != nil {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}

	if err = validatePassportActionValues(canonical); err != nil {
		return nativeAIAction{}, PassportCard{}, err
	}
	card, err := projectActionToCard(canonical)
	if err != nil {
		return nativeAIAction{}, PassportCard{}, invalidPassportProposal()
	}
	if err = validatePassportCardBounds(card); err != nil {
		return nativeAIAction{}, PassportCard{}, err
	}
	return canonical, card, nil
}

func isPassportServerOwnedKey(key string) bool {
	switch key {
	case "userId", "familyId", "babyId", "id", "source", "sourceAgent", "recordedByUserId", "createdByUserId", "version", "attachmentId", "productId", "formulaProductId":
		return true
	default:
		return false
	}
}

var passportDecimalLexical = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

func invalidPassportProposal() error {
	return providerFailure("INVALID_RECORD_PROPOSAL", "The proposed record is incomplete or cannot be shown faithfully. Please clarify the details and try again.", false)
}

func passportDecimalFields(kind string) []string {
	switch kind {
	case "feeding":
		return []string{"amountMl"}
	case "supplement":
		return []string{"dose"}
	case "growth":
		return []string{"weightKg", "heightCm", "headCircumferenceCm"}
	default:
		return nil
	}
}

func passportDecimalString(value any) (string, error) {
	switch number := value.(type) {
	case json.Number:
		if !passportDecimalLexical.MatchString(string(number)) {
			return "", errors.New("JSON number does not match decimal-string syntax")
		}
		return string(number), nil
	case float64, float32:
		return "", errors.New("floating-point decimal cannot be normalized without losing precision")
	case int:
		return strconv.Itoa(number), nil
	case int8:
		return strconv.FormatInt(int64(number), 10), nil
	case int16:
		return strconv.FormatInt(int64(number), 10), nil
	case int32:
		return strconv.FormatInt(int64(number), 10), nil
	case int64:
		return strconv.FormatInt(number, 10), nil
	case uint:
		return strconv.FormatUint(uint64(number), 10), nil
	case uint8:
		return strconv.FormatUint(uint64(number), 10), nil
	case uint16:
		return strconv.FormatUint(uint64(number), 10), nil
	case uint32:
		return strconv.FormatUint(uint64(number), 10), nil
	case uint64:
		return strconv.FormatUint(number, 10), nil
	case string:
		return number, nil
	default:
		return "", fmt.Errorf("unsupported decimal type %T", value)
	}
}

func validatePassportActionValues(action nativeAIAction) error {
	payload := action.Payload
	switch action.EntityType {
	case "food":
		ids, ok := payload["foodItemIds"].([]any)
		if !ok || len(ids) == 0 {
			if strings, ok := payload["foodItemIds"].([]string); ok && len(strings) > 0 {
				return validatePassportFoodIDs(strings)
			}
			return invalidPassportProposal()
		}
		foodIDs := make([]string, 0, len(ids))
		for _, raw := range ids {
			id, ok := raw.(string)
			if !ok {
				return invalidPassportProposal()
			}
			foodIDs = append(foodIDs, id)
		}
		return validatePassportFoodIDs(foodIDs)
	case "growth":
		measured := false
		for _, key := range []string{"heightCm", "weightKg", "headCircumferenceCm"} {
			if value, exists := payload[key]; exists && value != nil {
				if strings.TrimSpace(text(value)) == "" {
					return invalidPassportProposal()
				}
				measured = true
			}
		}
		if !measured {
			return invalidPassportProposal()
		}
	case "sleep":
		started, err := asTime(payload["startedAt"])
		if err != nil {
			return invalidPassportProposal()
		}
		if rawEnd, exists := payload["endedAt"]; exists && rawEnd != nil {
			ended, err := asTime(rawEnd)
			if err != nil || ended.Before(started) {
				return invalidPassportProposal()
			}
		}
	}
	return nil
}

func validatePassportFoodIDs(ids []string) error {
	if len(ids) == 0 {
		return invalidPassportProposal()
	}
	for _, id := range ids {
		if strings.TrimSpace(id) == "" {
			return invalidPassportProposal()
		}
	}
	return nil
}

func projectActionToCard(action nativeAIAction) (PassportCard, error) {
	card := PassportCard{
		SchemaVersion: 1,
		Kind:          "record_proposal",
		EntityType:    action.EntityType,
		Status:        "awaiting_confirmation",
		Footer:        "按中间键确认",
		Fields:        []PassportCardField{},
	}
	payload := action.Payload
	add := func(label, value, unit string, emphasis bool) error {
		if strings.TrimSpace(value) == "" {
			return invalidPassportProposal()
		}
		card.Fields = append(card.Fields, PassportCardField{Label: label, Value: value, Unit: unit, Emphasis: emphasis})
		return nil
	}
	addOptionalString := func(label, key, unit string, emphasis bool) error {
		value, exists := payload[key]
		if !exists || value == nil {
			return nil
		}
		return add(label, text(value), unit, emphasis)
	}
	addTime := func(label, key string) error {
		value, exists := payload[key]
		if !exists || value == nil {
			return nil
		}
		t, err := asTime(value)
		if err != nil {
			return invalidPassportProposal()
		}
		return add(label, t.Format(time.RFC3339Nano), "", false)
	}

	switch action.EntityType {
	case "feeding":
		card.Title = "记录喂奶"
		feedingType := map[string]string{"breast": "亲喂", "bottle": "瓶喂", "formula": "配方奶", "mixed": "混合喂养"}[text(payload["feedingType"])]
		if feedingType == "" {
			return card, invalidPassportProposal()
		}
		if err := add("类型", feedingType, "", false); err != nil {
			return card, err
		}
		if err := addOptionalString("奶量", "amountMl", "mL", true); err != nil {
			return card, err
		}
		if err := addTime("时间", "occurredAt"); err != nil {
			return card, err
		}
		if err := addOptionalString("左侧时长", "leftMinutes", "分钟", false); err != nil {
			return card, err
		}
		if err := addOptionalString("右侧时长", "rightMinutes", "分钟", false); err != nil {
			return card, err
		}
		if value, exists := payload["spitUp"]; exists && value != nil {
			flag, ok := value.(bool)
			if !ok {
				return card, invalidPassportProposal()
			}
			if err := add("吐奶", map[bool]string{true: "是", false: "否"}[flag], "", false); err != nil {
				return card, err
			}
		}
		if err := addOptionalString("备注", "notes", "", false); err != nil {
			return card, err
		}
	case "sleep":
		card.Title = "记录睡眠"
		sleepType := map[string]string{"nap": "小睡", "night": "夜间"}[text(payload["sleepType"])]
		if sleepType == "" {
			return card, invalidPassportProposal()
		}
		if err := add("类型", sleepType, "", false); err != nil {
			return card, err
		}
		if err := addTime("开始时间", "startedAt"); err != nil {
			return card, err
		}
		if end, exists := payload["endedAt"]; exists && end != nil {
			if err := addTime("结束时间", "endedAt"); err != nil {
				return card, err
			}
			start, _ := asTime(payload["startedAt"])
			ended, _ := asTime(end)
			if err := add("时长", ended.Sub(start).String(), "", true); err != nil {
				return card, err
			}
		} else if err := add("状态", "进行中", "", false); err != nil {
			return card, err
		}
		if err := addOptionalString("夜醒次数", "nightWakingCount", "次", false); err != nil {
			return card, err
		}
		if err := addOptionalString("备注", "notes", "", false); err != nil {
			return card, err
		}
	case "diaper":
		card.Title = "记录换尿布"
		diaperType := map[string]string{"pee": "小便", "poop": "大便", "both": "大小便"}[text(payload["diaperType"])]
		if diaperType == "" {
			return card, invalidPassportProposal()
		}
		if err := add("类型", diaperType, "", true); err != nil {
			return card, err
		}
		if err := addTime("时间", "occurredAt"); err != nil {
			return card, err
		}
		if err := addOptionalString("便便颜色", "poopColor", "", false); err != nil {
			return card, err
		}
		if err := addOptionalString("便便性状", "poopConsistency", "", false); err != nil {
			return card, err
		}
		if err := addOptionalString("备注", "notes", "", false); err != nil {
			return card, err
		}
	case "food":
		card.Title = "记录辅食"
		mealType := map[string]string{"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}[text(payload["mealType"])]
		if mealType == "" {
			return card, invalidPassportProposal()
		}
		if err := add("日期", text(payload["recordDate"]), "", false); err != nil {
			return card, err
		}
		if err := add("餐次", mealType, "", false); err != nil {
			return card, err
		}
		var foodIDs []string
		switch ids := payload["foodItemIds"].(type) {
		case []any:
			foodIDs = make([]string, 0, len(ids))
			for _, raw := range ids {
				id, ok := raw.(string)
				if !ok {
					return card, invalidPassportProposal()
				}
				foodIDs = append(foodIDs, id)
			}
		case []string:
			foodIDs = ids
		default:
			return card, invalidPassportProposal()
		}
		if err := add("食物", strings.Join(foodIDs, ", "), "", true); err != nil {
			return card, err
		}
		if err := addTime("发生时间", "occurredAt"); err != nil {
			return card, err
		}
		if err := addOptionalString("份量", "portionDescription", "", false); err != nil {
			return card, err
		}
		if reaction, exists := payload["reaction"]; exists && reaction != nil {
			reactionText := map[string]string{"like": "喜欢", "normal": "正常", "dislike": "不喜欢"}[text(reaction)]
			if reactionText == "" {
				return card, invalidPassportProposal()
			}
			if err := add("反应", reactionText, "", false); err != nil {
				return card, err
			}
		}
		if err := addOptionalString("备注", "notes", "", false); err != nil {
			return card, err
		}
	case "supplement":
		card.Title = "记录营养补充"
		if err := add("补充剂", text(payload["supplementName"]), "", true); err != nil {
			return card, err
		}
		if err := addOptionalString("剂量", "dose", text(payload["unitName"]), true); err != nil {
			return card, err
		}
		if err := addOptionalString("用量", "amount", "", false); err != nil {
			return card, err
		}
		if err := addOptionalString("单位", "unitName", "", false); err != nil {
			return card, err
		}
		if err := addTime("时间", "occurredAt"); err != nil {
			return card, err
		}
		if err := addOptionalString("备注", "notes", "", false); err != nil {
			return card, err
		}
	case "growth":
		card.Title = "生长记录"
		if err := add("测量日期", text(payload["measurementDate"]), "", false); err != nil {
			return card, err
		}
		for _, field := range []struct{ key, label, unit string }{
			{"weightKg", "体重", "kg"}, {"heightCm", "身高", "cm"}, {"headCircumferenceCm", "头围", "cm"},
		} {
			if err := addOptionalString(field.label, field.key, field.unit, true); err != nil {
				return card, err
			}
		}
		if err := addOptionalString("备注", "notes", "", false); err != nil {
			return card, err
		}
	default:
		return card, fmt.Errorf("unsupported entity type for card projection: %s", action.EntityType)
	}
	return card, nil
}

func validatePassportCardBounds(card PassportCard) error {
	if runeCount(card.Title) > passportMaxCardTitle || runeCount(card.Footer) > passportMaxCardFooter || len(card.Fields) > passportMaxCardFields {
		return providerFailure("PASSPORT_CARD_LIMIT_EXCEEDED", "The proposed record is too large to display clearly. Please simplify it and try again.", false)
	}
	for _, field := range card.Fields {
		if runeCount(field.Label) > passportMaxCardLabel || runeCount(field.Value) > passportMaxCardValue || runeCount(field.Unit) > passportMaxCardUnit {
			return providerFailure("PASSPORT_CARD_LIMIT_EXCEEDED", "The proposed record is too large to display clearly. Please simplify it and try again.", false)
		}
	}
	return nil
}

func runeCount(value string) int { return utf8.RuneCountInString(value) }

// executePassportCardConfirmation executes the transactional mutation confirmed by the physical middle button.
func (s *Server) executePassportCardConfirmation(ctx context.Context, principal *PassportPrincipal, runID, planHash, actionID, expectedPlanHash string, action nativeAIAction, expiry time.Time) (string, error) {
	if !time.Now().Before(principal.ExpiresAt) {
		return "", apiError(401, "INVALID_PASSPORT_TOKEN", "Passport token is expired")
	}
	if time.Now().After(expiry) {
		return "", apiError(409, "CONCURRENCY_CONFLICT", "Plan expired")
	}

	if subtle.ConstantTimeCompare([]byte(planHash), []byte(expectedPlanHash)) != 1 {
		return "", apiError(409, "CONCURRENCY_CONFLICT", "Plan hash mismatch")
	}
	var err error
	action, _, err = s.normalizeValidatePassportAction(action)
	if err != nil {
		return "", err
	}
	if action.ActionID != actionID {
		return "", apiError(409, "CONCURRENCY_CONFLICT", "Confirmed action ID does not match its proposal")
	}

	scope, err := babyScope(ctx, s.DB, principal.OwnerUserID, principal.BabyID, true)
	if err != nil {
		return "", err
	}
	if scope.FamilyID != principal.FamilyID {
		return "", apiError(403, "BABY_SCOPE_MISMATCH", "Device baby scope has changed")
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)

	if _, err = lockFamily(ctx, tx, scope.FamilyID); err != nil {
		return "", err
	}

	// A WebSocket may outlive device revocation or reassignment. Revalidate
	// its canonical scope under a row lock held until this write commits, so
	// revocation and confirmation have a definite order at the database.
	var authorizedDeviceID string
	err = tx.QueryRow(ctx, `SELECT id FROM passport_devices
		WHERE id = $1 AND owner_user_id = $2 AND family_id = $3 AND baby_id = $4
		AND revoked_at IS NULL FOR SHARE`, principal.DeviceID, principal.OwnerUserID,
		principal.FamilyID, principal.BabyID).Scan(&authorizedDeviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apiError(403, "DEVICE_ACCESS_REVOKED", "Device access has been revoked or its scope has changed")
	}
	if err != nil {
		return "", err
	}

	current, err := babyScope(ctx, tx, principal.OwnerUserID, scope.BabyID, true)
	if err != nil {
		return "", err
	}
	if current.FamilyID != scope.FamilyID {
		return "", apiError(403, "BABY_SCOPE_MISMATCH", "Run scope changed")
	}

	body := passportConfirmationBody(action)

	idempotencyKey := fmt.Sprintf("passport-confirm:%s:%s", runID, actionID)
	actionHash, err := snapshotHash(Object{"runId": runID, "planHash": planHash, "action": action})
	if err != nil {
		return "", err
	}

	reqPrincipal := Principal{
		UserID:      principal.OwnerUserID,
		SessionID:   principal.DeviceID,
		Username:    "passport",
		DeviceLabel: principal.DeviceLabel,
	}

	command, err := s.prepareRecordCommand(reqPrincipal, scope, action.EntityType, actionID, "create", idempotencyKey, actionHash, actionHash, 0, body, "passport")
	if err != nil {
		return "", err
	}
	if action.EntityType == "food" {
		apply := command.Apply
		command.Apply = func(applyCtx context.Context, applyTx pgx.Tx, existing Object, next int64) (recordChange, error) {
			if err := validatePassportFoodReferences(applyCtx, applyTx, scope.FamilyID, body); err != nil {
				return recordChange{}, err
			}
			return apply(applyCtx, applyTx, existing, next)
		}
	}

	req := &Request{
		Principal: reqPrincipal,
	}

	outcome, err := s.executeRecordCommandTx(ctx, tx, req, command)
	if err != nil {
		return "", err
	}

	if err = tx.Commit(ctx); err != nil {
		return "", err
	}

	recordID := text(outcome.Entity["id"])
	if recordID == "" {
		recordID = actionID
	}

	return recordID, nil
}

func passportConfirmationBody(action nativeAIAction) Object {
	body := copyObject(action.Payload)
	body["source"], body["sourceAgent"] = "passport", "passport"
	return body
}
