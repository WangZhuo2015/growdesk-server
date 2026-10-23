package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const familyNotificationSnapshotVersion = 1

type familyNotificationSnapshot struct {
	Version int    `json:"version"`
	Title   string `json:"title"`
	Body    string `json:"body"`
}

type familyNotificationRecordContent struct {
	Kind, Operation, ActorName, BabyName, TimeZone string
	Record                                         Object
	FoodItemNames                                  []string
	FormulaName                                    string
	FormulaID                                      string
	SupplementProductName                          string
}

func familyNotificationOperationName(operation string) string {
	switch operation {
	case "create":
		return "新增"
	case "update":
		return "更新"
	case "delete":
		return "删除"
	case "restore":
		return "恢复"
	default:
		return "更新"
	}
}

func familyNotificationRecordName(kind string) string {
	switch kind {
	case "feeding":
		return "喂奶"
	case "sleep":
		return "睡眠"
	case "diaper":
		return "尿布"
	case "food":
		return "辅食"
	case "supplement":
		return "补剂"
	case "growth":
		return "生长测量"
	default:
		return "照护"
	}
}

func validFamilyNotificationSnapshot(snapshot *familyNotificationSnapshot) bool {
	return snapshot != nil && snapshot.Version == familyNotificationSnapshotVersion && strings.TrimSpace(snapshot.Title) != "" && strings.TrimSpace(snapshot.Body) != ""
}

func renderFamilyNotificationSnapshot(content familyNotificationRecordContent) familyNotificationSnapshot {
	actor := familyNotificationDisplayValue(content.ActorName, "家庭成员")
	baby := familyNotificationDisplayValue(content.BabyName, "宝宝")
	title := actor + "为" + baby + familyNotificationOperationName(content.Operation) + familyNotificationRecordName(content.Kind) + "记录"
	zone, _ := familyNotificationLocation(content.TimeZone)
	parts := make([]string, 0, 12)
	record := content.Record

	addTime := func(label, key string) {
		if value := record[key]; familyNotificationValuePresent(value) {
			if rendered := familyNotificationTimestamp(value, zone); rendered != "" {
				parts = append(parts, label+rendered)
			}
		}
	}
	addText := func(label, key string) {
		if value := familyNotificationDisplayValue(text(record[key]), ""); value != "" {
			parts = append(parts, label+value)
		}
	}
	addNumeric := func(label, key, unit string) {
		if value := record[key]; value != nil && text(value) != "" {
			parts = append(parts, label+familyNotificationNumber(value)+unit)
		}
	}
	addNote := func() {
		if note := familyNotificationNote(text(record["notes"])); note != "" {
			parts = append(parts, "备注："+note)
		}
	}

	switch content.Kind {
	case "feeding":
		addTime("发生时间：", "occurred_at")
		if value := familyNotificationEnum(text(record["feeding_type"]), map[string]string{
			"breast": "亲喂", "bottle": "瓶喂", "formula": "配方奶", "mixed": "混合喂养",
		}); value != "" {
			parts = append(parts, "类型："+value)
		}
		addNumeric("奶量：", "amount_ml", " 毫升")
		addNumeric("左侧时长：", "left_minutes", " 分钟")
		addNumeric("右侧时长：", "right_minutes", " 分钟")
		addNumeric("总时长：", "duration_minutes", " 分钟")
		if content.FormulaName != "" {
			parts = append(parts, "奶粉："+familyNotificationDisplayValue(content.FormulaName, ""))
		} else if content.FormulaID != "" {
			parts = append(parts, "奶粉：未命名产品")
		}
		if value := record["spit_up"]; familyNotificationValuePresent(value) {
			parts = append(parts, "吐奶："+familyNotificationYesNo(value))
		}
		addNote()
	case "sleep":
		addTime("开始时间：", "started_at")
		if value := familyNotificationEnum(text(record["sleep_type"]), map[string]string{"nap": "白天小睡", "night": "夜间睡眠"}); value != "" {
			parts = append(parts, "类型："+value)
		}
		addTime("结束时间：", "ended_at")
		if duration := familyNotificationSleepDuration(record["started_at"], record["ended_at"]); duration != "" {
			parts = append(parts, "睡眠时长："+duration)
		}
		addNumeric("夜醒次数：", "night_waking_count", " 次")
		if !familyNotificationValuePresent(record["ended_at"]) {
			parts = append(parts, "状态：进行中")
		}
		addNote()
	case "diaper":
		addTime("发生时间：", "occurred_at")
		if value := familyNotificationEnum(text(record["diaper_type"]), map[string]string{"pee": "尿尿", "poop": "便便", "both": "尿便都有"}); value != "" {
			parts = append(parts, "类型："+value)
		}
		parts = addEnumText(parts, "便便颜色：", record["poop_color"], map[string]string{
			"yellow": "黄色", "brown": "棕色", "green": "绿色", "black": "黑色", "white": "白色", "red": "红色",
		})
		parts = addEnumText(parts, "便便性状：", record["poop_consistency"], map[string]string{
			"watery": "稀水样", "loose": "稀软", "soft": "柔软", "formed": "成形", "hard": "干硬", "mucus": "有黏液", "bloody": "带血",
		})
		addNote()
	case "food":
		occurredAt := record["occurred_at"]
		recordDate := familyNotificationDisplayValue(text(record["record_date"]), "")
		if familyNotificationValuePresent(occurredAt) {
			addTime("发生时间：", "occurred_at")
			if recordDate != "" {
				if localDate, ok := familyNotificationLocalDate(occurredAt, zone); !ok || localDate != recordDate {
					parts = append(parts, "记录日期："+recordDate)
				}
			}
		} else if recordDate != "" {
			parts = append(parts, "记录日期："+recordDate)
		}
		if value := familyNotificationEnum(text(record["meal_type"]), map[string]string{"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}); value != "" {
			parts = append(parts, "餐次："+value)
		}
		foodIDs := familyNotificationStringList(record["food_item_ids"])
		foodNames := content.FoodItemNames
		if len(foodIDs) > 0 {
			catalogNames := make(map[string]string)
			if len(foodNames) == len(foodIDs) {
				for index, id := range foodIDs {
					if name := familyNotificationDisplayValue(foodNames[index], ""); name != "" {
						catalogNames[id] = name
					}
				}
			}
			foodNames = familyNotificationFoodNames(foodIDs, catalogNames)
		}
		if len(foodNames) > 0 {
			parts = append(parts, "食物："+strings.Join(foodNames, "、"))
		}
		if portion := familyNotificationFoodPortion(text(record["portion_description"])); portion != "" {
			parts = append(parts, "份量："+portion)
		}
		parts = addEnumText(parts, "接受度：", record["reaction"], map[string]string{"like": "喜欢", "normal": "一般", "dislike": "不喜欢"})
		parts = append(parts, familyNotificationFoodObservationParts(text(record["notes"]))...)
	case "supplement":
		addTime("发生时间：", "occurred_at")
		addText("补剂：", "supplement_name")
		productName := familyNotificationDisplayValue(content.SupplementProductName, "")
		productID, cleanNotes, invalidProductTag := familyNotificationSupplementProductReference(text(record["product_id"]), text(record["notes"]))
		if productName != "" {
			parts = append(parts, "产品："+productName)
		} else if productID != "" || invalidProductTag {
			parts = append(parts, "产品：未命名补剂")
		}
		addText("用量：", "amount")
		if value := record["dose"]; value != nil && text(value) != "" {
			unit := text(record["unit_name"])
			if unit != "" {
				unit = " " + unit
			}
			parts = append(parts, "剂量："+familyNotificationNumber(value)+unit)
		}
		if invalidProductTag {
			parts = append(parts, "部分产品信息无法显示，请打开记录查看")
		}
		if note := familyNotificationNote(cleanNotes); note != "" {
			parts = append(parts, "备注："+note)
		}
	case "growth":
		if date := familyNotificationDisplayValue(text(record["measurement_date"]), ""); date != "" {
			parts = append(parts, "测量日期："+date)
		}
		addNumeric("体重：", "weight_kg", " 千克")
		addNumeric("身长：", "height_cm", " 厘米")
		addNumeric("头围：", "head_circumference_cm", " 厘米")
		if attachment := text(record["attachment_id"]); attachment != "" {
			parts = append(parts, "包含测量照片：是")
		}
		addNote()
	}

	body := strings.Join(parts, "；")
	if body == "" {
		body = "此记录暂无可显示的详细字段。"
	}
	return familyNotificationSnapshot{Version: familyNotificationSnapshotVersion, Title: title, Body: body}
}

func addEnumText(parts []string, label string, value any, names map[string]string) []string {
	if !familyNotificationValuePresent(value) {
		return parts
	}
	return append(parts, label+familyNotificationEnum(text(value), names))
}

func familyNotificationSleepDuration(start, end any) string {
	if !familyNotificationValuePresent(start) || !familyNotificationValuePresent(end) {
		return ""
	}
	startedAt, startErr := asTime(start)
	endedAt, endErr := asTime(end)
	if startErr != nil || endErr != nil || endedAt.Before(startedAt) {
		return ""
	}
	minutes := int(endedAt.Sub(startedAt).Minutes())
	if minutes < 60 {
		return fmt.Sprintf("%d 分钟", minutes)
	}
	return fmt.Sprintf("%d 小时 %d 分钟", minutes/60, minutes%60)
}

func familyNotificationEnum(value string, names map[string]string) string {
	if value == "" {
		return ""
	}
	if name, ok := names[value]; ok {
		return name
	}
	return familyNotificationDisplayValue(value, "")
}

func familyNotificationYesNo(value any) string {
	switch value := value.(type) {
	case bool:
		if value {
			return "是"
		}
		return "否"
	}
	switch strings.ToLower(strings.TrimSpace(text(value))) {
	case "true", "1", "yes":
		return "是"
	case "mild":
		return "轻微"
	case "false", "0", "no":
		return "否"
	default:
		return familyNotificationDisplayValue(text(value), "")
	}
}

func familyNotificationNumber(value any) string {
	if number, ok := value.(json.Number); ok {
		value = number.String()
	}
	return text(decimalValue(value))
}

func familyNotificationFoodPortion(value string) string {
	if value == "" {
		return ""
	}
	if label, ok := map[string]string{"little": "少量", "half": "半碗", "most": "大部分", "all": "全部"}[value]; ok {
		return label
	}
	return familyNotificationDisplayValue(value, "")
}

type familyNotificationFoodObservation struct {
	Notes         string
	Acceptance    int
	HasAcceptance bool
	BabyState     string
	HasAbnormal   bool
	AbnormalValue bool
	AbnormalNotes string
	Invalid       bool
}

func familyNotificationFoodObservationParts(value string) []string {
	observation := decodeFamilyNotificationFoodObservation(value)
	parts := make([]string, 0, 5)
	if observation.HasAcceptance {
		parts = append(parts, fmt.Sprintf("喜欢程度：%d/5", observation.Acceptance))
	}
	if observation.BabyState != "" {
		state := map[string]string{"happy": "开心", "neutral": "一般", "rejected": "拒绝"}[observation.BabyState]
		parts = append(parts, "进食状态："+state)
	}
	if observation.HasAbnormal {
		if observation.AbnormalValue {
			parts = append(parts, "异常情况：有异常")
			if note := strings.TrimSpace(observation.AbnormalNotes); note != "" {
				parts = append(parts, "异常备注："+note)
			}
		} else {
			parts = append(parts, "异常情况：无异常")
		}
	} else if note := strings.TrimSpace(observation.AbnormalNotes); note != "" {
		parts = append(parts, "异常备注："+note)
	}
	if observation.Invalid {
		parts = append(parts, "部分观察信息无法显示，请打开记录查看")
	}
	if note := familyNotificationNote(observation.Notes); note != "" {
		parts = append(parts, "备注："+note)
	}
	return parts
}

func decodeFamilyNotificationFoodObservation(value string) familyNotificationFoodObservation {
	const prefix = "[growdesk-web-food:v1]"
	const versionPrefix = "[growdesk-web-food:"
	if !strings.HasPrefix(value, versionPrefix) {
		return familyNotificationFoodObservation{Notes: value}
	}
	if !strings.HasPrefix(value, prefix) {
		return familyNotificationFoodObservation{Invalid: true}
	}
	result := familyNotificationFoodObservation{}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimPrefix(value, prefix)), &envelope); err != nil || envelope == nil {
		result.Invalid = true
		return result
	}
	if rawNotes, ok := envelope["notes"]; !ok {
		result.Invalid = true
	} else if strings.TrimSpace(string(rawNotes)) == "null" {
		result.Notes = ""
	} else if err := json.Unmarshal(rawNotes, &result.Notes); err != nil {
		result.Invalid = true
	}
	rawObservations, ok := envelope["observations"]
	if !ok || strings.TrimSpace(string(rawObservations)) == "null" {
		result.Invalid = true
		return result
	}
	var observations map[string]json.RawMessage
	if err := json.Unmarshal(rawObservations, &observations); err != nil || observations == nil {
		result.Invalid = true
		return result
	}
	for key, raw := range observations {
		switch key {
		case "acceptance":
			var decoded any
			decoder := json.NewDecoder(strings.NewReader(string(raw)))
			decoder.UseNumber()
			if err := decoder.Decode(&decoded); err != nil {
				result.Invalid = true
				continue
			}
			number, ok := decoded.(json.Number)
			if !ok {
				result.Invalid = true
				continue
			}
			acceptance, err := strconv.Atoi(number.String())
			if err != nil || acceptance < 1 || acceptance > 5 {
				result.Invalid = true
				continue
			}
			result.Acceptance, result.HasAcceptance = acceptance, true
		case "babyState":
			var state string
			if err := json.Unmarshal(raw, &state); err != nil || (state != "happy" && state != "neutral" && state != "rejected") {
				result.Invalid = true
				continue
			}
			result.BabyState = state
		case "hasAbnormal":
			if string(raw) == "null" || json.Unmarshal(raw, &result.AbnormalValue) != nil {
				result.Invalid = true
				continue
			}
			result.HasAbnormal = true
		case "abnormalNotes":
			if string(raw) == "null" || json.Unmarshal(raw, &result.AbnormalNotes) != nil {
				result.Invalid = true
			}
		}
	}
	return result
}

func familyNotificationSupplementProductReference(productID, notes string) (string, string, bool) {
	const prefix = "[productId:"
	if !strings.HasPrefix(notes, prefix) {
		return productID, notes, false
	}
	closingBracket := strings.IndexByte(notes[len(prefix):], ']')
	if closingBracket < 0 {
		if lineBreak := strings.IndexAny(notes, "\r\n"); lineBreak >= 0 {
			return productID, strings.TrimLeft(notes[lineBreak:], " \t\r\n"), true
		}
		return productID, "", true
	}
	taggedID := strings.TrimSpace(notes[len(prefix) : len(prefix)+closingBracket])
	if taggedID == "" {
		cleanNotes := strings.TrimLeft(notes[len(prefix)+closingBracket+1:], " \t\r\n")
		return productID, cleanNotes, true
	}
	if productID == "" {
		productID = taggedID
	}
	cleanNotes := strings.TrimLeft(notes[len(prefix)+closingBracket+1:], " \t\r\n")
	return productID, cleanNotes, false
}

func familyNotificationValuePresent(value any) bool {
	if value == nil {
		return false
	}
	switch value := value.(type) {
	case string:
		return strings.TrimSpace(value) != ""
	case time.Time:
		return !value.IsZero()
	case bool:
		return true
	default:
		return text(value) != ""
	}
}

func familyNotificationDisplayValue(value, fallback string) string {
	value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if value == "" {
		return fallback
	}
	return value
}

func familyNotificationNote(value string) string { return strings.TrimSpace(value) }

func familyNotificationLocation(zoneName string) (*time.Location, string) {
	zoneName = familyNotificationDisplayValue(zoneName, "UTC")
	location, err := time.LoadLocation(zoneName)
	if err != nil {
		return time.UTC, "UTC"
	}
	return location, zoneName
}

func familyNotificationTimestamp(value any, location *time.Location) string {
	instant, err := asTime(value)
	if err != nil {
		return ""
	}
	localTime := instant.In(location)
	if localTime.Nanosecond() != 0 {
		return localTime.Format("2006-01-02 15:04:05.000")
	}
	if localTime.Second() != 0 {
		return localTime.Format("2006-01-02 15:04:05")
	}
	return localTime.Format("2006-01-02 15:04")
}

func familyNotificationLocalDate(value any, location *time.Location) (string, bool) {
	instant, err := asTime(value)
	if err != nil {
		return "", false
	}
	return instant.In(location).Format("2006-01-02"), true
}

func familyNotificationStringList(value any) []string {
	switch values := value.(type) {
	case []string:
		result := make([]string, len(values))
		copy(result, values)
		return result
	case []any:
		result := make([]string, 0, len(values))
		for _, value := range values {
			if item, ok := value.(string); ok {
				result = append(result, item)
			} else {
				result = append(result, "")
			}
		}
		return result
	default:
		return nil
	}
}

func familyNotificationFoodNames(ids []string, catalogNames map[string]string) []string {
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			names = append(names, "未命名食物")
			continue
		}
		if name := familyNotificationDisplayValue(catalogNames[id], ""); name != "" {
			names = append(names, name)
		} else if !familyNotificationOpaqueFoodID(id) {
			names = append(names, familyNotificationDisplayValue(id, "未命名食物"))
		} else {
			names = append(names, "未命名食物")
		}
	}
	return names
}

func familyNotificationOpaqueFoodID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if familyNotificationLooksLikeUUID(value) {
		return true
	}
	lower := strings.ToLower(value)
	for _, prefix := range []string{"food_", "food-item-", "fooditem_", "fi_", "item_"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if len(value) >= 24 {
		hasDigit, asciiToken := false, true
		for _, r := range value {
			if r >= '0' && r <= '9' {
				hasDigit = true
			} else if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-' || r == '_' {
				// Still an ASCII identifier-shaped token.
			} else {
				asciiToken = false
				break
			}
		}
		if asciiToken && hasDigit {
			return true
		}
	}
	return false
}

func familyNotificationLooksLikeUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, r := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func legacyFamilyNotificationSnapshot(event familyRecordEvent, content familyNotificationRecordContent) familyNotificationSnapshot {
	if content.Record != nil && integer(content.Record["version"]) == event.Version {
		content.Kind, content.Operation = event.Kind, event.Operation
		return renderFamilyNotificationSnapshot(content)
	}

	actor := familyNotificationDisplayValue(content.ActorName, "家庭成员")
	baby := familyNotificationDisplayValue(content.BabyName, "宝宝")
	title := actor + "为" + baby + familyNotificationOperationName(event.Operation) + familyNotificationRecordName(event.Kind) + "记录"
	body := fmt.Sprintf("此通知对应旧记录版本 %d。", event.Version)
	if content.Record == nil {
		body += "原始记录已不存在，无法恢复当时详情。"
	} else {
		currentVersion := integer(content.Record["version"])
		if currentVersion > 0 {
			body += fmt.Sprintf("当前记录版本 %d 已变化；打开通知查看当前内容。", currentVersion)
		} else {
			body += "当前记录版本未知；打开通知查看当前内容。"
		}
	}
	return familyNotificationSnapshot{Version: familyNotificationSnapshotVersion, Title: title, Body: body}
}

func familyNotificationRecordTable(kind string) (string, bool) {
	tables := map[string]string{
		"feeding": "feeding_records", "sleep": "sleep_records", "diaper": "diaper_records",
		"food": "food_records", "supplement": "supplement_records", "growth": "growth_measurements",
	}
	table, ok := tables[kind]
	return table, ok
}

func loadFamilyNotificationRecord(ctx context.Context, q Querier, familyID, babyID, kind, recordID string) (Object, error) {
	table, ok := familyNotificationRecordTable(kind)
	if !ok {
		return nil, errors.New("unsupported family notification record kind")
	}
	return one(ctx, q, "SELECT to_jsonb(r) FROM "+pgx.Identifier{table}.Sanitize()+" r WHERE r.id=$1 AND r.family_id=$2 AND r.baby_id=$3", recordID, familyID, babyID)
}

func loadFamilyNotificationIdentity(ctx context.Context, q Querier, actorID, familyID, babyID string) (actor, baby, zone string, err error) {
	err = q.QueryRow(ctx, `SELECT COALESCE(NULLIF(u.display_name,''),NULLIF(u.username,''),'家庭成员'),
		COALESCE(NULLIF(b.nickname,''),'宝宝'),COALESCE(NULLIF(f.timezone,''),'UTC')
		FROM babies b JOIN families f ON f.id=b.family_id LEFT JOIN users u ON u.id=$1
		WHERE b.id=$2 AND b.family_id=$3`, actorID, babyID, familyID).Scan(&actor, &baby, &zone)
	return
}

func familyNotificationNames(ctx context.Context, q Querier, scope Scope, record Object) ([]string, string, string, error) {
	foodNames := []string(nil)
	ids := familyNotificationStringList(record["food_item_ids"])
	if len(ids) > 0 {
		rows, err := many(ctx, q, `SELECT to_jsonb(x) FROM food_library_items x
			WHERE x.id=ANY($1::text[]) AND (x.family_id IS NULL OR x.family_id=$2)`, ids, scope.FamilyID)
		if err != nil {
			return nil, "", "", err
		}
		names := make(map[string]string, len(rows))
		for _, row := range rows {
			if id, name := text(row["id"]), familyNotificationDisplayValue(text(row["name"]), ""); id != "" && name != "" {
				names[id] = name
			}
		}
		foodNames = familyNotificationFoodNames(ids, names)
	}
	formulaName, supplementName := "", ""
	if id := text(record["formula_product_id"]); id != "" {
		err := q.QueryRow(ctx, `SELECT concat_ws(' ',NULLIF(brand,''),name) FROM formula_products WHERE id=$1 AND family_id=$2`, id, scope.FamilyID).Scan(&formulaName)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, "", "", err
		}
	}
	if id, _, _ := familyNotificationSupplementProductReference(text(record["product_id"]), text(record["notes"])); id != "" {
		err := q.QueryRow(ctx, `SELECT concat_ws(' ',NULLIF(brand,''),name) FROM supplement_products WHERE id=$1 AND family_id=$2`, id, scope.FamilyID).Scan(&supplementName)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, "", "", err
		}
	}
	return foodNames, formulaName, supplementName, nil
}

func familyNotificationSnapshotFromRecord(ctx context.Context, q Querier, actorID string, scope Scope, event familyRecordEvent, requireMatchingVersion bool) (familyNotificationSnapshot, error) {
	record, err := loadFamilyNotificationRecord(ctx, q, scope.FamilyID, scope.BabyID, event.Kind, event.RecordID)
	if errors.Is(err, pgx.ErrNoRows) {
		if requireMatchingVersion {
			return familyNotificationSnapshot{}, errors.New("committed family notification record is missing")
		}
		record = nil
	} else if err != nil {
		return familyNotificationSnapshot{}, err
	}
	actor, baby, zone, err := loadFamilyNotificationIdentity(ctx, q, actorID, scope.FamilyID, scope.BabyID)
	if err != nil {
		return familyNotificationSnapshot{}, err
	}
	content := familyNotificationRecordContent{Kind: event.Kind, Operation: event.Operation, ActorName: actor, BabyName: baby, TimeZone: zone, Record: record}
	if record != nil {
		version := integer(record["version"])
		if requireMatchingVersion && version != event.Version {
			return familyNotificationSnapshot{}, errors.New("persisted family notification record version does not match event")
		}
		if !requireMatchingVersion && version != event.Version {
			return legacyFamilyNotificationSnapshot(event, content), nil
		}
		foodNames, formulaName, supplementName, err := familyNotificationNames(ctx, q, scope, record)
		if err != nil {
			return familyNotificationSnapshot{}, err
		}
		content.FoodItemNames, content.FormulaName, content.SupplementProductName = foodNames, formulaName, supplementName
		content.FormulaID = text(record["formula_product_id"])
	}
	if record == nil {
		return legacyFamilyNotificationSnapshot(event, content), nil
	}
	return renderFamilyNotificationSnapshot(content), nil
}

func familyPushWirePayload(title, body string, data Object, tag string, budget int) (Object, []byte, bool, error) {
	return familyPushBoundedPayload(body, budget, func(body string) Object {
		return Object{"title": title, "body": body, "data": data, "tag": tag, "url": "/notifications"}
	})
}

func familyAPNSWirePayload(title, body, notificationID string, data Object, budget int) (Object, []byte, bool, error) {
	return familyPushBoundedPayload(body, budget, func(body string) Object {
		return Object{"aps": Object{"alert": Object{"title": title, "body": body}, "sound": "default"}, "notificationId": notificationID, "data": data}
	})
}

func familyPushBoundedPayload(body string, budget int, payloadForBody func(string) Object) (Object, []byte, bool, error) {
	if budget <= 0 || payloadForBody == nil {
		return nil, nil, false, errors.New("invalid family push payload budget")
	}
	payload := payloadForBody(body)
	raw, err := jsonBytes(payload)
	if err != nil || len(raw) <= budget {
		return payload, raw, false, err
	}
	const suffix = "…点击查看完整内容"
	runes := []rune(body)
	low, high := 0, len(runes)
	var best Object
	var bestRaw []byte
	for low <= high {
		middle := low + (high-low)/2
		candidateBody := string(runes[:middle]) + suffix
		candidate := payloadForBody(candidateBody)
		encoded, encodeErr := jsonBytes(candidate)
		if encodeErr != nil {
			return nil, nil, false, encodeErr
		}
		if len(encoded) <= budget {
			best, bestRaw = candidate, encoded
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	if best == nil {
		return nil, nil, false, errors.New("family push metadata exceeds wire budget")
	}
	return best, bestRaw, true, nil
}
