package backend

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func testFamilyEvent() nativeTaskInput {
	input := nativeTaskInput{Version: 1, FamilyID: "11111111-1111-4111-8111-111111111111", BabyID: "22222222-2222-4222-8222-222222222222",
		FamilyRecord: &familyRecordEvent{ActorID: "33333333-3333-4333-8333-333333333333", Kind: "feeding", RecordID: "44444444-4444-4444-8444-444444444444", Operation: "create", Version: 1}}
	input.FamilyRecord.EventKey = familyRecordEventKey(input)
	return input
}

func TestFamilyNotificationStableEventIdentity(t *testing.T) {
	input := testFamilyEvent()
	key := input.FamilyRecord.EventKey
	input.FamilyRecord.ContentSnapshot = &familyNotificationSnapshot{Version: 1, Title: "测试标题", Body: "测试完整正文"}
	if familyRecordEventKey(input) != key || !validFamilyRecordInput(input) {
		t.Fatal("content snapshot changed event identity or invalidated the event")
	}
	if !validFamilyRecordInput(input) || !actionUUID.MatchString(familyStableID("event/"+key)) || familyRecordEventKey(input) != key {
		t.Fatal("committed event identity is invalid or unstable")
	}
	row := Object{"kind": familyRecordNotificationKind, "type": familyRecordNotificationKind, "payload_version": 1,
		"owner_scope": "family:" + input.FamilyID, "payload": Object{"__native": input}}
	decoded, err := decodeNativeTaskInput(row)
	if err != nil || decoded.FamilyRecord.ContentSnapshot == nil || decoded.FamilyRecord.ContentSnapshot.Body != "测试完整正文" {
		t.Fatalf("immutable content snapshot did not survive task serialization: %+v %v", decoded, err)
	}
	input.FamilyRecord.Version++
	if familyRecordEventKey(input) == key || validFamilyRecordInput(input) {
		t.Fatal("new version reused the event identity")
	}
	input.FamilyRecord.EventKey = familyRecordEventKey(input)
	if !validFamilyRecordInput(input) {
		t.Fatal("new record version rejected")
	}
	if familyStableID("notification/user-a/"+key) == familyStableID("notification/user-b/"+key) || familyStableID("delivery/a/device-a") == familyStableID("delivery/a/device-b") {
		t.Fatal("different recipients/devices share an identity")
	}
}

func TestFamilyNotificationTaskMetadataFailsClosed(t *testing.T) {
	input := testFamilyEvent()
	row := Object{"kind": familyRecordNotificationKind, "type": familyRecordNotificationKind, "payload_version": 1,
		"owner_scope": "family:" + input.FamilyID, "payload": Object{"__native": input}}
	if _, err := decodeNativeTaskInput(row); err != nil {
		t.Fatal(err)
	}
	for _, alteration := range []Object{{"owner_scope": "user:" + input.FamilyRecord.ActorID}, {"type": "push_delivery"}, {"payload_version": 2}, {"kind": "ai_chat_run", "type": "ai_chat_run"}} {
		bad := copyObject(row)
		for field, value := range alteration {
			bad[field] = value
		}
		if _, err := decodeNativeTaskInput(bad); err == nil {
			t.Fatal("accepted mixed task metadata", alteration)
		}
	}
	input.UserID = input.FamilyRecord.ActorID
	row["payload"] = Object{"__native": input}
	if _, err := decodeNativeTaskInput(row); err == nil {
		t.Fatal("family task bound to actor")
	}
	row["kind"], row["type"], row["owner_scope"] = "push_delivery", "push_delivery", "user:"+input.UserID
	input.NotificationID, input.PushDeviceID = input.FamilyID, input.BabyID
	row["payload"] = Object{"__native": input}
	if _, err := decodeNativeTaskInput(row); err == nil {
		t.Fatal("actor accepted as recipient")
	}
	input.UserID = "55555555-5555-4555-8555-555555555555"
	row["owner_scope"], row["payload"] = "user:"+input.UserID, Object{"__native": input}
	if _, err := decodeNativeTaskInput(row); err != nil {
		t.Fatal("valid recipient rejected", err)
	}
}

func TestFamilyNotificationQuietBoundariesAndDST(t *testing.T) {
	tests := []struct {
		name, zone, now, end string
		start, finish        int
	}{
		{"start inclusive", "Asia/Shanghai", "2026-05-02T14:00:00Z", "2026-05-02T23:00:00Z", 22 * 60, 7 * 60},
		{"end exclusive", "Asia/Shanghai", "2026-05-02T23:00:00Z", "", 22 * 60, 7 * 60},
		{"overnight", "Asia/Shanghai", "2026-05-02T18:15:35Z", "2026-05-02T23:00:00Z", 22 * 60, 7 * 60},
		{"daytime", "UTC", "2026-05-02T10:30:22Z", "2026-05-02T11:00:00Z", 10 * 60, 11 * 60},
		{"spring nonexistent end", "America/Los_Angeles", "2026-03-08T09:30:00Z", "2026-03-08T10:00:00Z", 22 * 60, 2*60 + 30},
		{"fall first end", "America/Los_Angeles", "2026-11-01T08:10:00Z", "2026-11-01T08:30:00Z", 0, 90},
		{"fall second end", "America/Los_Angeles", "2026-11-01T09:10:00Z", "2026-11-01T09:30:00Z", 0, 90},
		{"fall first nonquiet", "America/Los_Angeles", "2026-11-01T08:45:00Z", "", 0, 90},
		{"half hour spring gap", "Australia/Lord_Howe", "2026-10-03T15:20:00Z", "2026-10-03T15:30:00Z", 22 * 60, 2*60 + 15},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, test.now)
			if err != nil {
				t.Fatal(err)
			}
			pref := familyNotificationPreference{TimeZone: test.zone, Quiet: true, QuietStart: test.start, QuietEnd: test.finish}
			end, err := familyQuietEnd(pref, now)
			if err != nil {
				t.Fatal(err)
			}
			if test.end == "" {
				if !end.IsZero() {
					t.Fatal("outside quiet window deferred", end)
				}
			} else if end.UTC().Format(time.RFC3339) != test.end {
				t.Fatalf("end=%s expected=%s", end, test.end)
			}
		})
	}
}

func TestFamilyNotificationPreferencesValidation(t *testing.T) {
	body := Object{"timeZone": "Asia/Shanghai", "kinds": Object{"family_record": true}, "quietHours": nil}
	pref, err := requestFamilyPreference(body)
	if err != nil || pref.Quiet || !pref.Enabled {
		t.Fatal(pref, err)
	}
	for _, bad := range []Object{
		{"timeZone": "Local"}, {"timeZone": "test_Invalid/Zone"},
		{"kinds": Object{"family_record": "true"}},
		{"quietHours": Object{"start": "24:00", "end": "07:00"}},
		{"quietHours": Object{"start": "22:00", "end": "22:00"}},
		{"quietHours": Object{"start": "2:00", "end": "07:00"}},
		{"babyId": "not-a-uuid"},
	} {
		candidate := copyObject(body)
		for key, value := range bad {
			candidate[key] = value
		}
		if _, err := requestFamilyPreference(candidate); err == nil {
			t.Fatal("accepted invalid preference", bad)
		}
	}
	pref.TimeZone, pref.Quiet, pref.QuietStart, pref.QuietEnd = "UTC", true, 1, 1
	if _, err := familyQuietEnd(pref, time.Now()); err == nil {
		t.Fatal("accepted invalid retained quiet window")
	}
}

func TestFamilyNotificationPayloadContainsOnlyMetadata(t *testing.T) {
	input := testFamilyEvent()
	input.Message = "test_private_record_body"
	raw, err := json.Marshal(familyNotificationData(input))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), input.Message) || strings.Contains(string(raw), "token") || !strings.Contains(string(raw), `"eventKind":"family_record"`) || !strings.Contains(string(raw), `"recordVersion":"1"`) {
		t.Fatal("unexpected notification metadata", string(raw))
	}
}

func TestFamilyNotificationWNSHostBoundary(t *testing.T) {
	c := Config{Environment: "production"}
	if _, err := nativePushEndpoint(c, "https://wns2-test.notify.windows.com/w/?token=test"); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"http://wns2-test.notify.windows.com/w/", "https://wns2-test.notify.windows.com:8443/w/", "https://wns2-test.notify.windows.com.evil.invalid/w/", "https://evilnotify.windows.com/w/", "https://test@wns2-test.notify.windows.com/w/"} {
		if _, err := nativePushEndpoint(c, endpoint); err == nil {
			t.Fatal("accepted unsafe WNS endpoint", endpoint)
		}
	}
	t.Setenv("GROWDESK_PUSH_TEST_ORIGIN", "http://127.0.0.1:25491")
	if _, err := nativePushEndpoint(Config{Environment: "test"}, "https://wns2-test.notify.windows.com/w/"); err == nil {
		t.Fatal("preview accepted public WNS endpoint")
	}
}
