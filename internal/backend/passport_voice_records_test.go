package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPassportVoiceRecordQueryIntentSelectsOnlyRelevantDataKinds(t *testing.T) {
	tests := []struct {
		name       string
		transcript string
		want       []string
	}{
		{name: "feeding question", transcript: "今天宝宝喝了多少奶？", want: []string{"feeding"}},
		{name: "feeding count request", transcript: "查询宝宝今天奶量", want: []string{"feeding"}},
		{name: "feeding stats request", transcript: "统计宝宝今天奶量", want: []string{"feeding"}},
		{name: "yesterday feeding question", transcript: "昨天喝了多少奶", want: []string{"feeding"}},
		{name: "feeding record is requested with a read verb", transcript: "看看喂奶记录", want: []string{"feeding"}},
		{name: "list feeding records", transcript: "列出喂奶记录", want: []string{"feeding"}},
		{name: "diaper question", transcript: "宝宝最近尿布情况怎么样？", want: []string{"diaper"}},
		{name: "food question", transcript: "最近辅食吃了什么？", want: []string{"food"}},
		{name: "recent feeding quality question", transcript: "最近宝宝喝奶怎么样？", want: []string{"feeding"}},
		{name: "food definition is not a history request", transcript: "辅食是什么？", want: nil},
		{name: "generic record request", transcript: "看看宝宝最近记录", want: passportAllPassportVoiceRecordKinds()},
		{name: "generic summary", transcript: "最近宝宝情况总结", want: passportAllPassportVoiceRecordKinds()},
		{name: "device operation is not data", transcript: "介绍设备怎么操作", want: nil},
		{name: "explicit record request is not a query", transcript: "帮我记录宝宝喝了120毫升奶", want: nil},
		{name: "natural write request is not a query", transcript: "我想记录宝宝喝了120毫升奶", want: nil},
		{name: "save request is not a query", transcript: "请帮我保存宝宝今天喝了140毫升奶", want: nil},
		{name: "add request is not a query", transcript: "我想新增宝宝今天喂奶记录", want: nil},
		{name: "backfill request is not a query", transcript: "我需要补记宝宝昨天睡觉", want: nil},
		{name: "polite record request with duration query words is not a query", transcript: "麻烦记录一下宝宝昨天睡了多久，一个半小时", want: nil},
		{name: "imperative backfill with recent query words is not a query", transcript: "把最近一次喂奶记下来，120毫升", want: nil},
		{name: "polite bare record request is not a query", transcript: "麻烦记录宝宝喝了140毫升奶", want: nil},
		{name: "record statement is not a query", transcript: "记录宝宝今天喝了140毫升奶", want: nil},
		{name: "care statement is not a query", transcript: "宝宝今天喝了140毫升奶", want: nil},
		{name: "medical advice is not a history request", transcript: "宝宝今天应该喝多少奶", want: nil},
		{name: "sleep recommendation is not a history request", transcript: "最近宝宝应该多睡吗？", want: nil},
		{name: "food recommendation is not a history request", transcript: "最近辅食应该吃什么？", want: nil},
		{name: "record failure is not a history request", transcript: "为什么奶量记录失败？", want: nil},
		{name: "record guidance is not a history request", transcript: "怎么记录喂奶？", want: nil},
		{name: "record instructions are not a history request", transcript: "请介绍如何记录睡眠", want: nil},
		{name: "cleaning advice is not a history request", transcript: "怎么清洗奶瓶", want: nil},
		{name: "ordinary chat is not data", transcript: "你好，今天心情怎么样？", want: nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := passportVoiceRecordQueryKinds(test.transcript); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("selected record kinds for %q = %#v, want %#v", test.transcript, got, test.want)
			}
		})
	}
}

func TestPassportVoiceRecordContextEnforcesSerializedByteBudget(t *testing.T) {
	kinds := passportAllPassportVoiceRecordKinds()
	recordTypes := Object{}
	for _, kind := range kinds {
		samples := make([]Object, passportVoiceRecordLimit)
		for index := range samples {
			samples[index] = Object{"localDate": "2026-10-02", "notes": strings.Repeat("界", 160)}
		}
		recordTypes[kind] = Object{"recentWindow": Object{
			"recordCount": int64(passportVoiceRecordLimit), "includedRecordCount": len(samples), "truncated": false, "samples": samples,
		}}
	}
	data := Object{"includedRecordTypes": kinds, "recordTypes": recordTypes}
	changed, err := boundPassportVoiceRecordContext(data)
	if err != nil {
		t.Fatalf("bound the serialized record context: %v", err)
	}
	serialized, err := jsonText(data)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(serialized) > passportVoiceRecordContextMaxBytes {
		t.Fatalf("context byte budget outcome: changed=%t size=%d limit=%d", changed, len(serialized), passportVoiceRecordContextMaxBytes)
	}
	for kind, value := range obj(data["recordTypes"]) {
		for _, sample := range obj(obj(value)["recentWindow"])["samples"].([]Object) {
			if _, exists := sample["notes"]; exists {
				t.Fatalf("oversized context retained optional free-text notes for %s", kind)
			}
		}
	}
}

func TestPassportVoiceRecordContextAllKindsIntegration(t *testing.T) {
	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	if _, err := h.controlDB.Exec(context.Background(), `UPDATE families SET timezone='America/Los_Angeles' WHERE id=$1`, fx.familyID); err != nil {
		t.Fatalf("set isolated family timezone: %v", err)
	}
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	reference := time.Date(2026, 10, 3, 0, 30, 0, 0, time.UTC)
	at := reference.Add(-30 * time.Minute)
	localDate := at.In(location).Format("2006-01-02")
	foodID := seedPassportTestFoodItem(t, context.Background(), h.controlDB, fx)
	rows := []struct {
		kind    string
		entity  string
		payload Object
	}{
		{"feeding", "feeding", Object{"feedingType": "formula", "amountMl": "120", "occurredAt": at.Format(time.RFC3339Nano), "notes": "test_untrusted_feeding_note"}},
		{"sleep", "sleep", Object{"sleepType": "nap", "startedAt": at.Add(-45 * time.Minute).Format(time.RFC3339Nano), "endedAt": at.Format(time.RFC3339Nano), "nightWakingCount": 0, "notes": "test_untrusted_sleep_note"}},
		{"diaper", "diaper", Object{"diaperType": "both", "occurredAt": at.Format(time.RFC3339Nano), "poopColor": "brown", "poopConsistency": "soft", "notes": "test_untrusted_diaper_note"}},
		{"food", "food", Object{"recordDate": localDate, "mealType": "lunch", "occurredAt": at.Format(time.RFC3339Nano), "foodItemIds": []any{foodID}, "portionDescription": "test pear portion", "reaction": "like", "notes": "test_untrusted_food_note"}},
		{"supplement", "supplement", Object{"supplementName": "test_vitamin_d", "occurredAt": at.Format(time.RFC3339Nano), "amount": "1.25 mL", "dose": "1.25", "unitName": "mL", "notes": "test_untrusted_supplement_note"}},
		{"growth", "growth", Object{"measurementDate": localDate, "weightKg": "6.25", "heightCm": "61.2", "headCircumferenceCm": "40.1", "notes": "test_untrusted_growth_note"}},
	}
	recordIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		actionID, runID := newID(), newID()
		planHash := "test_plan_" + newID()
		action := nativeAIAction{ActionID: actionID, EntityType: row.entity, Operation: "create", Summary: "Test Passport " + row.kind, Payload: row.payload}
		recordID, err := h.server.executePassportCardConfirmation(context.Background(), fx.principal, runID, planHash, actionID, planHash, action, time.Now().Add(2*time.Minute))
		if err != nil || recordID == "" {
			t.Fatalf("seed %s through the real confirmation transaction: id=%q err=%v", row.kind, recordID, err)
		}
		recordIDs = append(recordIDs, recordID)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	loaded, err := h.server.loadPassportVoiceRecordContextForKinds(ctx, fx.principal, reference, passportAllPassportVoiceRecordKinds())
	if err != nil {
		t.Fatalf("load six authorized record types from isolated PostgreSQL: %v", err)
	}
	if loaded.TimeZone != "America/Los_Angeles" || loaded.TotalRecordCount != 6 || loaded.RecentRecordCount != 6 || loaded.Truncated {
		t.Fatalf("six-type context summary = timezone %q total %d recent %d truncated %t", loaded.TimeZone, loaded.TotalRecordCount, loaded.RecentRecordCount, loaded.Truncated)
	}
	recordTypes := obj(loaded.Data["recordTypes"])
	for _, kind := range passportAllPassportVoiceRecordKinds() {
		kindContext := obj(recordTypes[kind])
		allTime := obj(kindContext["allTime"])
		recent := obj(kindContext["recentWindow"])
		if allTime["count"] != int64(1) || allTime["earliestDate"] != localDate || allTime["latestDate"] != localDate || recent["recordCount"] != int64(1) {
			t.Errorf("%s coverage = allTime %#v recentCount %#v; want one record on %s", kind, allTime, recent["recordCount"], localDate)
		}
		samples, ok := recent["samples"].([]Object)
		if !ok || len(samples) != 1 {
			t.Errorf("%s sample list = %#v; want one authorized sample", kind, recent["samples"])
		}
	}
	food := obj(recordTypes["food"])
	foodSamples := obj(food["recentWindow"])["samples"].([]Object)
	foodNames, _ := jsonText(foodSamples[0]["foods"])
	if !strings.Contains(foodNames, "Test Passport Pear") {
		t.Errorf("food sample did not resolve its family-authorized catalog name: %#v", foodSamples[0])
	}
	serialized, err := jsonText(loaded.Data)
	if err != nil {
		t.Fatal(err)
	}
	if len(serialized) > passportVoiceRecordContextMaxBytes {
		t.Fatalf("serialized record context is %d bytes, over %d-byte budget", len(serialized), passportVoiceRecordContextMaxBytes)
	}
	for _, identifier := range append(recordIDs, fx.userID, fx.familyID, fx.babyID, foodID) {
		if strings.Contains(serialized, identifier) {
			t.Errorf("model context contains a private database identifier")
		}
	}
	for _, forbidden := range []string{"family_id", "baby_id", "source_agent", "recorded_by_user_id", "attachment_id"} {
		if strings.Contains(serialized, forbidden) {
			t.Errorf("model context contains forbidden implementation field %q", forbidden)
		}
	}
	if !strings.Contains(serialized, "test_untrusted_feeding_note") {
		t.Error("bounded user-entered notes were omitted from all-type context")
	}

	empty := newPassportConfirmationFixture(t, h.controlDB)
	emptyContext, err := h.server.loadPassportVoiceRecordContextForKinds(ctx, empty.principal, reference, passportAllPassportVoiceRecordKinds())
	if err != nil || emptyContext.HasAnyRecords || emptyContext.TotalRecordCount != 0 || emptyContext.RecentRecordCount != 0 {
		t.Fatalf("legitimate empty record scope was confused with a loader failure: context=%#v err=%v", emptyContext, err)
	}
	for _, kind := range passportAllPassportVoiceRecordKinds() {
		kindContext := obj(obj(emptyContext.Data["recordTypes"])[kind])
		allTime := obj(kindContext["allTime"])
		recent := obj(kindContext["recentWindow"])
		if allTime["count"] != int64(0) || allTime["earliestDate"] != nil || allTime["latestDate"] != nil || recent["recordCount"] != int64(0) || recent["truncated"] != false {
			t.Errorf("empty %s context is not explicit: %#v", kind, kindContext)
		}
	}
	if _, err := h.controlDB.Exec(ctx, `UPDATE passport_devices SET revoked_at=clock_timestamp() WHERE id=$1`, empty.deviceID); err != nil {
		t.Fatalf("revoke test Passport device: %v", err)
	}
	_, err = h.server.loadPassportVoiceRecordContextForKinds(ctx, empty.principal, reference, []string{"feeding"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "DEVICE_ACCESS_REVOKED" {
		t.Fatalf("revoked Passport device read error = %v; want DEVICE_ACCESS_REVOKED", err)
	}

	removedMember := newPassportConfirmationFixture(t, h.controlDB)
	if _, err := h.controlDB.Exec(ctx, `UPDATE baby_members SET status='revoked' WHERE baby_id=$1 AND user_id=$2`, removedMember.babyID, removedMember.userID); err != nil {
		t.Fatalf("revoke test baby membership: %v", err)
	}
	_, err = h.server.loadPassportVoiceRecordContextForKinds(ctx, removedMember.principal, reference, []string{"feeding"})
	apiErr = nil
	if !errors.As(err, &apiErr) || apiErr.Code != "BABY_ACCESS_DENIED" {
		t.Fatalf("revoked baby membership read error = %v; want BABY_ACCESS_DENIED", err)
	}
}

func TestPassportVoiceRecordContextLocalWindowAndTruncationIntegration(t *testing.T) {
	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	foreign := newPassportConfirmationFixture(t, h.controlDB)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := h.controlDB.Exec(ctx, `UPDATE families SET timezone='America/Los_Angeles' WHERE id=$1`, fx.familyID); err != nil {
		t.Fatalf("set isolated family timezone: %v", err)
	}
	reference := time.Date(2026, 10, 3, 0, 30, 0, 0, time.UTC) // 2026-10-02 17:30 in Los Angeles.
	insert := func(fixture *passportConfirmationFixture, at time.Time, amount string, note string, deleted bool) {
		t.Helper()
		var deletedAt any
		if deleted {
			deletedAt = at
		}
		id := "test_voice_feed_" + strings.ReplaceAll(newID(), "-", "")
		if _, err := h.controlDB.Exec(ctx, `INSERT INTO feeding_records(id,family_id,baby_id,feeding_type,occurred_at,amount_ml,notes,deleted_at,updated_at)
			VALUES($1,$2,$3,'formula',$4,$5,$6,$7,clock_timestamp())`, id, fixture.familyID, fixture.babyID, at, amount, note, deletedAt); err != nil {
			t.Fatalf("insert isolated feed fixture: %v", err)
		}
	}
	insert(fx, time.Date(2026, 9, 26, 6, 59, 59, 0, time.UTC), "3", "test_before_window", false) // Sep 25 23:59:59 local.
	insert(fx, time.Date(2026, 9, 26, 7, 0, 0, 0, time.UTC), "5", "test_window_start", false)    // Sep 26 00:00 local, inclusive.
	for index := 0; index < 13; index++ {
		insert(fx, time.Date(2026, 10, 2, 18, index, 0, 0, time.UTC), "100", "test_recent", false)
	}
	insert(fx, time.Date(2026, 10, 3, 7, 0, 0, 0, time.UTC), "7", "test_after_window", false) // Oct 3 00:00 local, exclusive end.
	insert(fx, time.Date(2026, 10, 2, 19, 0, 0, 0, time.UTC), "9999", "test_soft_deleted", true)
	insert(foreign, time.Date(2026, 10, 2, 19, 0, 0, 0, time.UTC), "8888", "test_foreign_family", false)

	loaded, err := h.server.loadPassportVoiceRecordContextForKinds(ctx, fx.principal, reference, []string{"feeding"})
	if err != nil {
		t.Fatalf("read bounded local window from isolated PostgreSQL: %v", err)
	}
	if loaded.TotalRecordCount != 16 || loaded.RecentRecordCount != 14 || !loaded.Truncated {
		t.Fatalf("window stats = total %d recent %d truncated %t; want 16, 14, true", loaded.TotalRecordCount, loaded.RecentRecordCount, loaded.Truncated)
	}
	kind := obj(obj(loaded.Data["recordTypes"])["feeding"])
	allTime := obj(kind["allTime"])
	recent := obj(kind["recentWindow"])
	if allTime["count"] != int64(16) || allTime["earliestDate"] != "2026-09-25" || allTime["latestDate"] != "2026-10-03" {
		t.Fatalf("all-time local coverage = %#v", allTime)
	}
	if recent["recordCount"] != int64(14) || recent["includedRecordCount"] != 12 || recent["truncated"] != true {
		t.Fatalf("recent detail coverage = %#v", recent)
	}
	samples := recent["samples"].([]Object)
	for _, sample := range samples {
		if strings.Contains(text(sample["notes"]), "test_soft_deleted") || strings.Contains(text(sample["notes"]), "test_foreign_family") || strings.Contains(text(sample["notes"]), "test_before_window") || strings.Contains(text(sample["notes"]), "test_after_window") {
			t.Fatalf("out-of-scope or out-of-window record entered samples: %#v", sample)
		}
	}
	days := recent["dailyTotals"].([]Object)
	dayTotals := make(map[string]Object, len(days))
	for _, day := range days {
		dayTotals[text(day["date"])] = day
	}
	if len(days) != 7 || text(dayTotals["2026-09-26"]["recordCount"]) != "1" || text(dayTotals["2026-09-26"]["amountMl"]) != "5.000" {
		t.Fatalf("inclusive first local day bucket = %#v", dayTotals["2026-09-26"])
	}
	if text(dayTotals["2026-10-02"]["recordCount"]) != "13" || text(dayTotals["2026-10-02"]["amountMl"]) != "1300.000" {
		t.Fatalf("exact daily count/feeding total = %#v", dayTotals["2026-10-02"])
	}
	if dayTotals["2026-09-27"]["recordCount"] != int64(0) {
		t.Fatalf("zero-data day is not explicit: %#v", dayTotals["2026-09-27"])
	}
	serialized, err := jsonText(loaded.Data)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(serialized, "test_foreign_family") || strings.Contains(serialized, "test_soft_deleted") || strings.Contains(serialized, fx.familyID) || strings.Contains(serialized, fx.babyID) {
		t.Fatal("foreign, soft-deleted, or scope identifiers entered model context")
	}
}

func TestPassportVoiceQueryRejectsProviderWriteActionIntegration(t *testing.T) {
	clearSpeechTestEnvironment(t)
	var receivedBody []byte
	observations := make(chan []byte, 1)
	provider := newPassportRecordContextTestProvider(t, "今天宝宝喝了多少奶？", Object{
		"text": "test provider claims it saved a record",
		"actions": []any{Object{
			"entityType": "feeding", "operation": "create", "summary": "Test query mutation",
			"payload": Object{"feedingType": "formula", "occurredAt": "2026-10-02T18:00:00Z", "amountMl": "20"},
		}},
	}, observations)
	defer provider.Close()
	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	marker := "test_authorized_read_only_query_" + strings.ReplaceAll(newID(), "-", "")
	seedPassportVoiceFeedingConfirmation(t, h, fx, time.Now().UTC(), "120", marker)
	configurePassportRecordContextProvider(t, provider.URL)
	t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
	wav := passportVoiceTestWAV()
	events := make([]Object, 0, 4)
	var playback passportPlaybackControl
	var pending passportPending[pendingCardProposal]
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	h.server.processVoiceTurn(ctx, fx.principal, "", "Test Baby", "test_query_action", wav,
		func(value any) error { events = append(events, value.(Object)); return nil },
		func([]byte) error { t.Error("query action rejection unexpectedly started TTS"); return nil },
		&playback, nil, &pending)
	select {
	case receivedBody = <-observations:
	case <-time.After(time.Second):
		t.Fatal("local model provider did not receive the query")
	}
	if !bytes.Contains(receivedBody, []byte(marker)) {
		t.Fatal("read-only query did not receive its authorized feeding context")
	}
	if len(events) != 2 || events[0]["type"] != "asr.final" || events[1]["type"] != "error" || events[1]["code"] != "QUERY_ACTION_REJECTED" {
		t.Fatalf("provider write action was not rejected with a typed diagnostic: %#v", events)
	}
	for _, event := range events {
		if event["type"] == "card.present" || event["type"] == "assistant.final" {
			t.Fatalf("unsafe provider query response was published: %#v", events)
		}
	}
	if pending.load() != nil {
		t.Fatal("query write action left a pending confirmation")
	}
	assertPassportVoiceFeedingCount(t, ctx, h, fx, 1)
}

func TestPassportVoiceNonDataOperationOmitsRecordContextIntegration(t *testing.T) {
	clearSpeechTestEnvironment(t)
	observations := make(chan []byte, 1)
	provider := newPassportRecordContextTestProvider(t, "介绍设备怎么操作", Object{"text": "test operation explanation", "actions": []any{}}, observations)
	defer provider.Close()
	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	if _, err := h.controlDB.Exec(context.Background(), `UPDATE families SET timezone='America/Los_Angeles' WHERE id=$1`, fx.familyID); err != nil {
		t.Fatalf("set isolated family timezone: %v", err)
	}
	marker := "test_operation_must_not_read_" + strings.ReplaceAll(newID(), "-", "")
	seedPassportVoiceFeedingConfirmation(t, h, fx, time.Now().UTC(), "120", marker)
	configurePassportRecordContextProvider(t, provider.URL)
	t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
	var playback passportPlaybackControl
	var pending passportPending[pendingCardProposal]
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	localDateBefore := time.Now().In(mustLoadPassportTestLocation(t, "America/Los_Angeles")).Format("2006-01-02")
	var events []Object
	h.server.processVoiceTurn(ctx, fx.principal, "", "Test Baby", "test_operation_no_records", passportVoiceTestWAV(),
		func(value any) error { events = append(events, value.(Object)); return nil },
		func([]byte) error { return nil }, &playback, nil, &pending)
	var body []byte
	select {
	case body = <-observations:
	case <-time.After(time.Second):
		t.Fatal("local model provider did not receive the operation question")
	}
	if bytes.Contains(body, []byte(marker)) || bytes.Contains(body, []byte(`"recordTypes"`)) || bytes.Contains(body, []byte(`"recentWindow"`)) {
		t.Fatal("non-data device-operation request included recent record context")
	}
	location := mustLoadPassportTestLocation(t, "America/Los_Angeles")
	localDateAfter := time.Now().In(location).Format("2006-01-02")
	if !bytes.Contains(body, []byte("America/Los_Angeles")) ||
		(!bytes.Contains(body, []byte("local calendar date is "+localDateBefore)) && !bytes.Contains(body, []byte("local calendar date is "+localDateAfter))) {
		t.Fatal("non-data prompt omitted the revalidated family timezone or its local calendar date")
	}
	foundAnswer := false
	for _, event := range events {
		if event["type"] == "assistant.final" && event["text"] == "test operation explanation" {
			foundAnswer = true
		}
	}
	if !foundAnswer {
		t.Fatalf("operation answer did not complete normally: %#v", events)
	}
	assertPassportVoiceFeedingCount(t, ctx, h, fx, 1)
}

func TestPassportVoiceWriteTurnUsesFamilyTimeZoneWithoutRecordContextIntegration(t *testing.T) {
	clearSpeechTestEnvironment(t)
	observations := make(chan []byte, 1)
	assistant := Object{"text": "test write preview", "actions": []any{Object{
		"entityType": "sleep", "operation": "create", "summary": "test sleep proposal",
		"payload": Object{"sleepType": "nap", "startedAt": time.Now().UTC().Add(-90 * time.Minute).Format(time.RFC3339), "endedAt": time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339)},
	}}}
	provider := newPassportRecordContextTestProvider(t, "麻烦记录一下宝宝昨天睡了多久，一个半小时", assistant, observations)
	defer provider.Close()
	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	if _, err := h.controlDB.Exec(context.Background(), `UPDATE families SET timezone='America/Los_Angeles' WHERE id=$1`, fx.familyID); err != nil {
		t.Fatalf("set isolated family timezone: %v", err)
	}
	marker := "test_write_must_not_read_" + strings.ReplaceAll(newID(), "-", "")
	seedPassportVoiceFeedingConfirmation(t, h, fx, time.Now().UTC(), "95", marker)
	configurePassportRecordContextProvider(t, provider.URL)
	t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
	var playback passportPlaybackControl
	var pending passportPending[pendingCardProposal]
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	localDateBefore := time.Now().In(mustLoadPassportTestLocation(t, "America/Los_Angeles")).Format("2006-01-02")
	var events []Object
	h.server.processVoiceTurn(ctx, fx.principal, "", "Test Baby", "test_write_local_timezone", passportVoiceTestWAV(),
		func(value any) error { events = append(events, value.(Object)); return nil },
		func([]byte) error { return nil }, &playback, nil, &pending)
	var body []byte
	select {
	case body = <-observations:
	case <-time.After(time.Second):
		t.Fatal("local model provider did not receive the write request")
	}
	if bytes.Contains(body, []byte(marker)) || bytes.Contains(body, []byte(`"recordTypes"`)) || bytes.Contains(body, []byte(`"recentWindow"`)) {
		t.Fatal("explicit record request included historical record context")
	}
	location := mustLoadPassportTestLocation(t, "America/Los_Angeles")
	localDateAfter := time.Now().In(location).Format("2006-01-02")
	if !bytes.Contains(body, []byte("America/Los_Angeles")) ||
		(!bytes.Contains(body, []byte("local calendar date is "+localDateBefore)) && !bytes.Contains(body, []byte("local calendar date is "+localDateAfter))) {
		t.Fatal("write prompt omitted the revalidated family timezone or its local calendar date")
	}
	foundProposal := false
	for _, event := range events {
		if event["type"] == "card.present" {
			foundProposal = true
		}
	}
	if !foundProposal || pending.load() == nil {
		t.Fatalf("write request did not create a confirmation proposal: events=%#v pending=%#v", events, pending.load())
	}
	assertPassportVoiceFeedingCount(t, ctx, h, fx, 1)
}

func mustLoadPassportTestLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load test timezone %q: %v", name, err)
	}
	return location
}

func newPassportRecordContextTestProvider(t *testing.T, transcript string, assistant Object, observations chan<- []byte) *httptest.Server {
	t.Helper()
	content, err := json.Marshal(assistant)
	if err != nil {
		t.Fatal(err)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/audio/transcriptions":
			_, _ = io.WriteString(w, `{"text":"`+transcript+`"}`)
		case "/v1/chat/completions":
			body, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024))
			if err != nil {
				http.Error(w, "test provider could not read request", http.StatusBadRequest)
				return
			}
			observations <- body
			_ = json.NewEncoder(w).Encode(Object{"choices": []any{Object{"message": Object{"content": string(content)}}}})
		default:
			http.NotFound(w, r)
		}
	}))
	return provider
}

func configurePassportRecordContextProvider(t *testing.T, baseURL string) {
	t.Helper()
	t.Setenv("GROWDESK_AI_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_AI_BASE_URL", baseURL+"/v1")
	t.Setenv("GROWDESK_AI_API_KEY", "test_local_query_ai_key")
	t.Setenv("GROWDESK_AI_MODEL", "test_local_query_model")
	t.Setenv("GROWDESK_ASR_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_ASR_BASE_URL", baseURL+"/v1")
	t.Setenv("GROWDESK_ASR_API_KEY", "test_local_query_asr_key")
	t.Setenv("GROWDESK_ASR_MODEL", "test_local_query_asr")
}

func passportVoiceTestWAV() []byte {
	pcm := make([]byte, 1600)
	pcm[0] = 1
	return buildWavFile(pcm, 16000, 1, 16)
}

func seedPassportVoiceFeedingConfirmation(t *testing.T, h *passportConfirmationPG, fx *passportConfirmationFixture, at time.Time, amount, note string) string {
	t.Helper()
	actionID, runID := newID(), newID()
	planHash := "test_plan_" + newID()
	action := nativeAIAction{ActionID: actionID, EntityType: "feeding", Operation: "create", Summary: "Test Passport feeding record",
		Payload: Object{"feedingType": "formula", "amountMl": amount, "occurredAt": at.Format(time.RFC3339Nano), "notes": note}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	recordID, err := h.server.executePassportCardConfirmation(ctx, fx.principal, runID, planHash, actionID, planHash, action, time.Now().Add(2*time.Minute))
	if err != nil || recordID == "" {
		t.Fatalf("seed test Passport feeding through real confirmation transaction: id=%q err=%v", recordID, err)
	}
	return recordID
}

func assertPassportVoiceFeedingCount(t *testing.T, ctx context.Context, h *passportConfirmationPG, fx *passportConfirmationFixture, want int) {
	t.Helper()
	requirePassportTableRecordCount(t, ctx, h.controlDB, "feeding_records", fx, want)
}
