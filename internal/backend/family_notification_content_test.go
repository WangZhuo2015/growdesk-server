package backend

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRenderFamilyNotificationSnapshotIncludesPersistedRecordDetails(t *testing.T) {
	at := time.Date(2026, 10, 6, 15, 15, 0, 0, time.UTC)
	tests := []struct {
		name, kind, operation string
		wantTitle             string
		record                Object
		foodNames             []string
		formulaName           string
		want                  []string
	}{
		{
			name: "feeding preserves enum, zero values, amount, product, spit up, note and timezone",
			kind: "feeding", operation: "create", formulaName: "test_formula_name",
			wantTitle: "测试家长为测试宝宝新增喂奶记录",
			record:    Object{"occurred_at": at, "feeding_type": "formula", "amount_ml": json.Number("0.000"), "left_minutes": 0, "right_minutes": 12, "spit_up": "false", "notes": "test_feeding_note"},
			want:      []string{"配方奶", "奶量：0 毫升", "左侧时长：0 分钟", "右侧时长：12 分钟", "test_formula_name", "吐奶：否", "test_feeding_note", "发生时间：2026-10-06 08:15"},
		},
		{
			name: "sleep keeps zero waking count and interval",
			kind: "sleep", operation: "update",
			wantTitle: "测试家长为测试宝宝更新睡眠记录",
			record:    Object{"sleep_type": "night", "started_at": at.Add(-time.Hour), "ended_at": at, "night_waking_count": 0, "notes": "test_sleep_note"},
			want:      []string{"夜间睡眠", "开始时间：2026-10-06 07:15", "结束时间：2026-10-06 08:15", "睡眠时长：1 小时 0 分钟", "夜醒次数：0 次", "test_sleep_note"},
		},
		{
			name: "diaper keeps type, color, consistency and note",
			kind: "diaper", operation: "delete",
			wantTitle: "测试家长为测试宝宝删除尿布记录",
			record:    Object{"diaper_type": "both", "occurred_at": at, "poop_color": "brown", "poop_consistency": "soft", "notes": "test_diaper_note"},
			want:      []string{"尿便都有", "便便颜色：棕色", "便便性状：柔软", "test_diaper_note"},
		},
		{
			name: "food resolves item names and keeps portion reaction and note",
			kind: "food", operation: "restore",
			wantTitle: "测试家长为测试宝宝恢复辅食记录",
			record:    Object{"record_date": "2026-10-06", "meal_type": "lunch", "occurred_at": at, "portion_description": "test_half_bowl", "reaction": "like", "notes": "test_food_note"},
			foodNames: []string{"test_pear", "test_oat"},
			want:      []string{"午餐", "食物：test_pear、test_oat", "test_half_bowl", "接受度：喜欢", "test_food_note", "发生时间：2026-10-06 08:15"},
		},
		{
			name: "supplement keeps amount dose unit and note",
			kind: "supplement", operation: "create",
			wantTitle: "测试家长为测试宝宝新增补剂记录",
			record:    Object{"supplement_name": "test_vitamin_d", "occurred_at": at, "amount": "0 mL", "dose": json.Number("0.00000"), "unit_name": "mL", "notes": "test_supplement_note"},
			want:      []string{"test_vitamin_d", "用量：0 mL", "剂量：0 mL", "test_supplement_note", "发生时间：2026-10-06 08:15"},
		},
		{
			name: "growth keeps zero-valued measurements and date-only clock",
			kind: "growth", operation: "create",
			wantTitle: "测试家长为测试宝宝新增生长测量记录",
			record:    Object{"measurement_date": "2026-10-06", "weight_kg": json.Number("0.00"), "height_cm": json.Number("72.0"), "head_circumference_cm": json.Number("0.0"), "notes": "test_growth_note"},
			want:      []string{"测量日期：2026-10-06", "体重：0 千克", "身长：72 厘米", "头围：0 厘米", "test_growth_note"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := renderFamilyNotificationSnapshot(familyNotificationRecordContent{
				Kind: test.kind, Operation: test.operation, ActorName: "测试家长", BabyName: "测试宝宝",
				TimeZone: "America/Los_Angeles", Record: test.record, FoodItemNames: test.foodNames, FormulaName: test.formulaName,
			})
			if snapshot.Version != 1 || snapshot.Title != test.wantTitle {
				t.Fatalf("unexpected immutable title: %+v", snapshot)
			}
			for _, part := range test.want {
				if !strings.Contains(snapshot.Body, part) {
					t.Errorf("body %q does not include %q", snapshot.Body, part)
				}
			}
			if strings.Contains(snapshot.Body, "test_pear、test_oat") && strings.Index(snapshot.Body, "test_food_note") < strings.Index(snapshot.Body, "食物：") {
				t.Fatal("notes must follow structured details so wire truncation retains event facts")
			}
		})
	}
}

func TestLegacyFamilyNotificationFallbackNeverUsesLaterRecordVersion(t *testing.T) {
	event := familyRecordEvent{ActorID: "actor", Kind: "feeding", RecordID: "record", Operation: "update", Version: 1}
	input := familyNotificationRecordContent{Kind: "feeding", Operation: "update", ActorName: "测试家长", BabyName: "测试宝宝", TimeZone: "UTC", Record: Object{
		"version": 2, "feeding_type": "formula", "occurred_at": time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC), "amount_ml": "999", "notes": "test_future_note",
	}}
	snapshot := legacyFamilyNotificationSnapshot(event, input)
	if strings.Contains(snapshot.Body, "999") || strings.Contains(snapshot.Body, "test_future_note") || !strings.Contains(snapshot.Body, "旧记录版本 1") || !strings.Contains(snapshot.Body, "当前记录版本 2") {
		t.Fatalf("legacy event incorporated a later record state: %+v", snapshot)
	}
	event.Version = 2
	snapshot = legacyFamilyNotificationSnapshot(event, input)
	if !strings.Contains(snapshot.Body, "奶量：999 毫升") || !strings.Contains(snapshot.Body, "test_future_note") {
		t.Fatalf("matching legacy record version did not provide its scoped detail: %+v", snapshot)
	}
	input.Record = nil
	event.Version = 1
	snapshot = legacyFamilyNotificationSnapshot(event, input)
	if !strings.Contains(snapshot.Body, "原始记录已不存在") || strings.Contains(snapshot.Body, "999") {
		t.Fatalf("missing legacy record fallback is unclear or invents details: %+v", snapshot)
	}
}

func TestFamilyNotificationSnapshotPreservesNoteWhitespaceAndLineBreaks(t *testing.T) {
	note := " 第一行\n第二行  保留连续空格\n第三行 "
	snapshot := renderFamilyNotificationSnapshot(familyNotificationRecordContent{
		Kind: "feeding", Operation: "create", ActorName: "测试家长", BabyName: "测试宝宝", TimeZone: "UTC",
		Record: Object{"feeding_type": "formula", "amount_ml": "120", "notes": note},
	})
	if !strings.HasSuffix(snapshot.Body, "备注："+strings.TrimSpace(note)) || strings.Contains(snapshot.Body, "第一行 第二行") {
		t.Fatalf("inbox snapshot normalized meaningful note whitespace: %q", snapshot.Body)
	}
}

func TestFamilyNotificationFoodCopyRendersLegacyObservationCapsuleWithoutInternalEncoding(t *testing.T) {
	notes := `[growdesk-web-food:v1]{"notes":"第一行备注\n第二行备注","observations":{"acceptance":5,"babyState":"happy","hasAbnormal":false,"abnormalNotes":"不应显示","futureField":"test_internal_value"}}`
	localTime := time.Date(2026, 10, 7, 11, 35, 0, 0, time.FixedZone("test_plus_eight", 8*60*60))
	snapshot := renderFamilyNotificationSnapshot(familyNotificationRecordContent{
		Kind: "food", Operation: "create", ActorName: "测试家长", BabyName: "测试宝宝", TimeZone: "Asia/Shanghai",
		Record: Object{
			"occurred_at": localTime, "record_date": "2026-10-07", "meal_type": "lunch",
			"food_item_ids":       []string{"胡萝卜泥", "8b9d3058-1de3-4b8a-96d7-154d3ec310e7"},
			"portion_description": "most", "notes": notes,
		},
	})
	for _, want := range []string{
		"发生时间：2026-10-07 11:35", "餐次：午餐", "食物：胡萝卜泥、未命名食物",
		"份量：大部分", "喜欢程度：5/5", "进食状态：开心", "异常情况：无异常",
		"备注：第一行备注\n第二行备注",
	} {
		if !strings.Contains(snapshot.Body, want) {
			t.Errorf("readable food snapshot %q does not include %q", snapshot.Body, want)
		}
	}
	for _, forbidden := range []string{
		"Asia/Shanghai", "+08:00", "11:35:00", "记录日期：2026-10-07", "食物项 ID：",
		"8b9d3058-1de3-4b8a-96d7-154d3ec310e7", "most", "[growdesk-web-food:v1]", "futureField", "test_internal_value", "不应显示",
	} {
		if strings.Contains(snapshot.Body, forbidden) {
			t.Errorf("readable food snapshot leaked or duplicated %q: %q", forbidden, snapshot.Body)
		}
	}
}

func TestFamilyNotificationSupplementCopyRemovesLegacyProductIDTagAndPreservesNote(t *testing.T) {
	productID := "test_internal_product_123"
	snapshot := renderFamilyNotificationSnapshot(familyNotificationRecordContent{
		Kind: "supplement", Operation: "create", ActorName: "测试家长", BabyName: "测试宝宝", TimeZone: "UTC",
		Record: Object{
			"supplement_name": "测试维生素", "product_id": productID,
			"notes": "[productId:" + productID + "] 早餐后服用\n第二行备注",
		},
	})
	if !strings.Contains(snapshot.Body, "产品：未命名补剂") || !strings.Contains(snapshot.Body, "备注：早餐后服用\n第二行备注") {
		t.Fatalf("supplement snapshot did not preserve readable content: %q", snapshot.Body)
	}
	if strings.Contains(snapshot.Body, productID) || strings.Contains(snapshot.Body, "[productId:") {
		t.Fatalf("supplement snapshot exposed an internal product reference: %q", snapshot.Body)
	}

	malformedTag := renderFamilyNotificationSnapshot(familyNotificationRecordContent{
		Kind: "supplement", Operation: "create", ActorName: "测试家长", BabyName: "测试宝宝", TimeZone: "UTC",
		Record: Object{"notes": "[productId:]早餐后服用\n第二行备注"},
	})
	if !strings.Contains(malformedTag.Body, "产品：未命名补剂") || !strings.Contains(malformedTag.Body, "早餐后服用\n第二行备注") || strings.Contains(malformedTag.Body, "[productId:") {
		t.Fatalf("malformed product tag hid readable notes or exposed internal metadata: %q", malformedTag.Body)
	}
}

func TestFamilyNotificationFoodCopyPreservesValidFieldsBesideInvalidObservation(t *testing.T) {
	notes := `[growdesk-web-food:v1]{"notes":"实际备注第一行\n实际备注第二行","observations":{"acceptance":4,"babyState":"future_state","hasAbnormal":true,"abnormalNotes":"红疹\n已经消退","futureField":"test_hidden_value"}}`
	snapshot := renderFamilyNotificationSnapshot(familyNotificationRecordContent{
		Kind: "food", Operation: "update", ActorName: "测试家长", BabyName: "测试宝宝", TimeZone: "Asia/Shanghai",
		Record: Object{
			"occurred_at": time.Date(2026, 10, 7, 11, 35, 42, 125_000_000, time.FixedZone("test_plus_eight", 8*60*60)),
			"record_date": "2026-10-06", "portion_description": "little", "notes": notes,
		},
	})
	for _, want := range []string{
		"发生时间：2026-10-07 11:35:42.125", "记录日期：2026-10-06", "份量：少量",
		"喜欢程度：4/5", "异常情况：有异常", "异常备注：红疹\n已经消退",
		"部分观察信息无法显示，请打开记录查看", "备注：实际备注第一行\n实际备注第二行",
	} {
		if !strings.Contains(snapshot.Body, want) {
			t.Errorf("partial observation output %q does not include %q", snapshot.Body, want)
		}
	}
	for _, forbidden := range []string{"future_state", "test_hidden_value", "[growdesk-web-food:v1]", "abnormalNotes"} {
		if strings.Contains(snapshot.Body, forbidden) {
			t.Errorf("partial observation output leaked %q: %q", forbidden, snapshot.Body)
		}
	}
}

func TestFamilyNotificationFoodCopyKeepsAbnormalNoteWhenStatusIsUnavailable(t *testing.T) {
	notes := `[growdesk-web-food:v1]{"notes":"test_human_note","observations":{"hasAbnormal":"unknown","abnormalNotes":"红疹说明"}}`
	parts := strings.Join(familyNotificationFoodObservationParts(notes), "；")
	if !strings.Contains(parts, "异常备注：红疹说明") || !strings.Contains(parts, "部分观察信息无法显示，请打开记录查看") || !strings.Contains(parts, "备注：test_human_note") {
		t.Fatalf("valid abnormal notes or user notes were discarded with an invalid status: %q", parts)
	}
	if strings.Contains(parts, "异常情况：无异常") || strings.Contains(parts, "unknown") {
		t.Fatalf("unknown abnormal status was guessed or exposed: %q", parts)
	}
}

func TestFamilyNotificationFoodObservationDecodeIsVersionScopedAndKeepsOrdinaryJSON(t *testing.T) {
	unknownVersion := `[growdesk-web-food:v2]{"notes":"test_hidden_note","observations":{"newField":"test_hidden_value"}}`
	unknownParts := strings.Join(familyNotificationFoodObservationParts(unknownVersion), "；")
	if !strings.Contains(unknownParts, "部分观察信息无法显示，请打开记录查看") || strings.Contains(unknownParts, "test_hidden_note") || strings.Contains(unknownParts, "test_hidden_value") {
		t.Fatalf("unknown observation version was guessed or exposed: %q", unknownParts)
	}

	ordinaryJSON := `{"notes":"ordinary user JSON","observations":{"acceptance":5}}`
	ordinaryParts := strings.Join(familyNotificationFoodObservationParts(ordinaryJSON), "；")
	if ordinaryParts != "备注："+ordinaryJSON {
		t.Fatalf("ordinary JSON note was changed: %q", ordinaryParts)
	}
}

func TestFamilyNotificationFoodNamesKeepCatalogLegacyAndFallbackItemsInOrder(t *testing.T) {
	ids := []string{
		"food_item_removed_123", "胡萝卜泥", "8b9d3058-1de3-4b8a-96d7-154d3ec310e7", "rolled oats", "food_removed_or_unknown",
	}
	names := familyNotificationFoodNames(ids, map[string]string{"food_item_removed_123": "测试目录梨"})
	want := []string{"测试目录梨", "胡萝卜泥", "未命名食物", "rolled oats", "未命名食物"}
	if strings.Join(names, "、") != strings.Join(want, "、") {
		t.Fatalf("food names lost order, a readable legacy name, or a fallback: %#v", names)
	}
	if strings.Contains(strings.Join(names, "、"), "food_item_removed_123") || strings.Contains(strings.Join(names, "、"), "8b9d3058-1de3-4b8a-96d7-154d3ec310e7") || strings.Contains(strings.Join(names, "、"), "food_removed_or_unknown") {
		t.Fatalf("food names exposed opaque identifiers: %#v", names)
	}
	missing := familyNotificationFoodNames(familyNotificationStringList([]any{"", nil}), nil)
	if strings.Join(missing, "、") != "未命名食物、未命名食物" {
		t.Fatalf("unresolved list elements were silently dropped: %#v", missing)
	}
}

func TestFamilyPushPayloadClipsUnicodeWithinWireBudgetWithoutChangingInboxSnapshot(t *testing.T) {
	fullBody := "发生时间：2026-10-06 08:15:00 +08:00（Asia/Shanghai）；奶量：120 毫升；备注：" + strings.Repeat("宝宝喜欢吃苹果🍎", 400)
	snapshot := familyNotificationSnapshot{Version: 1, Title: "测试家长为测试宝宝新增喂奶记录", Body: fullBody}
	payload, raw, clipped, err := familyPushWirePayload(snapshot.Title, snapshot.Body, Object{"eventKey": "test_event_key", "recordVersion": "1"}, "test_notification_id", 3072)
	if err != nil {
		t.Fatal(err)
	}
	if !clipped || len(raw) > 3072 || !utf8.Valid(raw) || !strings.Contains(text(payload["body"]), "…点击查看完整内容") {
		t.Fatalf("wire payload was not safely clipped: bytes=%d clipped=%t body=%q", len(raw), clipped, payload["body"])
	}
	if !strings.Contains(text(payload["body"]), "奶量：120 毫升") || payload["data"] == nil || !strings.Contains(string(raw), "test_event_key") {
		t.Fatalf("clipping dropped a structured fact or stable metadata: %s", raw)
	}
	if snapshot.Body != fullBody || !strings.HasSuffix(snapshot.Body, strings.Repeat("宝宝喜欢吃苹果🍎", 400)) {
		t.Fatal("wire clipping mutated the full inbox snapshot")
	}
}
