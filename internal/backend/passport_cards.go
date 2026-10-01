package backend

import (
	"context"
	"crypto/subtle"
	"fmt"
	"time"
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
	PlanHash  string `json:"planHash"`
	ActionIDs []string `json:"actionIds"`
	ExpiresAt string `json:"expiresAt"`
}

func projectActionToCard(action nativeAIAction) (PassportCard, error) {
	card := PassportCard{
		SchemaVersion: 1,
		Kind:          "record_proposal",
		EntityType:    action.EntityType,
		Status:        "awaiting_confirmation",
		Footer:        "按 OK 键确认",
	}

	payload := action.Payload
	occurredTimeStr := "刚刚"
	if occ := text(payload["occurredAt"]); occ != "" {
		if t, err := time.Parse(time.RFC3339, occ); err == nil {
			occurredTimeStr = t.Local().Format("15:04")
		}
	}

	switch action.EntityType {
	case "feeding":
		card.Title = "记录喂奶"
		feedType := "配方奶"
		if ft := text(payload["type"]); ft != "" {
			if ft == "breast_milk" {
				feedType = "母乳"
			} else if ft == "formula" {
				feedType = "配方奶"
			} else if ft == "water" {
				feedType = "水"
			}
		}
		amount := text(payload["amountMl"])
		if amount == "" {
			amount = "0"
		}
		card.Fields = []PassportCardField{
			{Label: "类型", Value: feedType},
			{Label: "奶量", Value: amount, Unit: "mL", Emphasis: true},
			{Label: "时间", Value: occurredTimeStr},
		}

	case "sleep":
		card.Title = "记录睡眠"
		durationStr := "进行中"
		if dur := text(payload["durationMinutes"]); dur != "" {
			durationStr = dur + " 分钟"
		}
		card.Fields = []PassportCardField{
			{Label: "状态", Value: "睡眠"},
			{Label: "时长", Value: durationStr, Emphasis: true},
			{Label: "时间", Value: occurredTimeStr},
		}

	case "diaper":
		card.Title = "记录换尿布"
		status := "小便"
		if dt := text(payload["type"]); dt != "" {
			if dt == "wet" {
				status = "小便"
			} else if dt == "dirty" {
				status = "大便"
			} else if dt == "both" {
				status = "两者皆有"
			} else if dt == "dry" {
				status = "干净"
			}
		}
		card.Fields = []PassportCardField{
			{Label: "状态", Value: status, Emphasis: true},
			{Label: "时间", Value: occurredTimeStr},
		}

	case "food":
		card.Title = "记录辅食"
		foodName := text(payload["foodName"])
		if foodName == "" {
			foodName = "辅食"
		}
		card.Fields = []PassportCardField{
			{Label: "食物", Value: foodName, Emphasis: true},
			{Label: "时间", Value: occurredTimeStr},
		}

	case "supplement":
		card.Title = "营养补充"
		productName := text(payload["productName"])
		if productName == "" {
			productName = "营养素"
		}
		card.Fields = []PassportCardField{
			{Label: "项目", Value: productName, Emphasis: true},
			{Label: "时间", Value: occurredTimeStr},
		}

	case "growth":
		card.Title = "生长记录"
		var fields []PassportCardField
		if h := text(payload["heightCm"]); h != "" {
			fields = append(fields, PassportCardField{Label: "身高", Value: h, Unit: "cm", Emphasis: true})
		}
		if w := text(payload["weightKg"]); w != "" {
			fields = append(fields, PassportCardField{Label: "体重", Value: w, Unit: "kg", Emphasis: true})
		}
		if len(fields) == 0 {
			fields = append(fields, PassportCardField{Label: "测量", Value: "已记录"})
		}
		fields = append(fields, PassportCardField{Label: "时间", Value: occurredTimeStr})
		card.Fields = fields

	default:
		return card, fmt.Errorf("unsupported entity type for card projection: %s", action.EntityType)
	}

	return card, nil
}

// executePassportCardConfirmation executes the transactional mutation confirmed by the physical OK button
func (s *Server) executePassportCardConfirmation(ctx context.Context, principal *PassportPrincipal, runID, planHash, actionID, expectedPlanHash string, action nativeAIAction, expiry time.Time) (string, error) {
	if time.Now().After(expiry) {
		return "", apiError(409, "CONCURRENCY_CONFLICT", "Plan expired")
	}

	if subtle.ConstantTimeCompare([]byte(planHash), []byte(expectedPlanHash)) != 1 {
		return "", apiError(409, "CONCURRENCY_CONFLICT", "Plan hash mismatch")
	}

	scope, err := babyScope(ctx, s.DB, principal.OwnerUserID, principal.BabyID, true)
	if err != nil {
		return "", err
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)

	if _, err = lockFamily(ctx, tx, scope.FamilyID); err != nil {
		return "", err
	}

	current, err := babyScope(ctx, tx, principal.OwnerUserID, scope.BabyID, true)
	if err != nil {
		return "", err
	}
	if current.FamilyID != scope.FamilyID {
		return "", apiError(403, "BABY_SCOPE_MISMATCH", "Run scope changed")
	}

	body := copyObject(action.Payload)
	for _, key := range []string{"userId", "familyId", "babyId", "id", "source", "sourceAgent"} {
		delete(body, key)
	}

	// Normalizations
	if v := body["amountMl"]; v != nil {
		body["amountMl"] = text(v)
	}
	if v := body["heightCm"]; v != nil {
		body["heightCm"] = text(v)
	}
	if v := body["weightKg"]; v != nil {
		body["weightKg"] = text(v)
	}
	if v := body["headCircumferenceCm"]; v != nil {
		body["headCircumferenceCm"] = text(v)
	}

	body["source"], body["sourceAgent"] = "passport", "passport"

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
