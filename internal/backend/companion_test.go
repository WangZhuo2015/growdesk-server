package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestCompanionNativeRegistration(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.RegisterBusinessHandlers()
	for _, tc := range []struct{ method, path string }{
		{"PUT", "/api/v1/devices/" + testUUID + "/push"}, {"DELETE", "/api/v1/devices/" + testUUID + "/push"},
		{"GET", "/api/v1/notifications"}, {"POST", "/api/v1/notifications/" + testUUID + "/read"},
		{"POST", "/api/v1/voice/logs"}, {"GET", "/api/v1/voice/logs"},
		{"GET", "/api/v1/voice/logs/" + testUUID}, {"PATCH", "/api/v1/voice/logs/" + testUUID},
		{"POST", "/api/v1/web/ai/sessions"}, {"GET", "/api/v1/web/ai/sessions"},
		{"GET", "/api/v1/web/ai/sessions/" + testUUID}, {"PATCH", "/api/v1/web/ai/sessions/" + testUUID},
		{"DELETE", "/api/v1/web/ai/sessions/" + testUUID}, {"POST", "/api/v1/web/ai/sessions/" + testUUID + "/messages"},
		{"GET", "/api/v1/families/" + testUUID + "/nutrition/products"},
		{"POST", "/api/v1/families/" + testUUID + "/nutrition/products"},
		{"PATCH", "/api/v1/families/" + testUUID + "/nutrition/products/" + testUUID},
		{"DELETE", "/api/v1/families/" + testUUID + "/nutrition/products/" + testUUID},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			route, _ := contract.Match(tc.method, tc.path)
			if route == nil || s.Handlers[route.OperationID] == nil || s.Public[route.OperationID] {
				t.Fatal("missing native implementation or missing authentication")
			}
		})
	}
	if s.Handlers["createAiRun"] != nil {
		t.Fatal("conversation history must not be reported as an AI execution engine")
	}
}

func TestCompanionResponseContracts(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	notification := notificationDTO(Object{"id": testUUID, "user_id": testUUID, "event_key": "test_event",
		"title": "Test", "body": "Test notification", "created_at": testTime})
	voice := voiceLogDTO(Object{"id": testUUID, "user_id": testUUID, "family_id": testUUID, "baby_id": testUUID,
		"prompt": "test_prompt", "reply": "test_reply", "is_async": false, "is_fast_path": false, "acknowledged": false,
		"created_at": testTime, "baby": Object{"id": testUUID, "nickname": "test_baby", "gender": "female"}})
	sessionRow := Object{"id": testUUID, "user_id": testUUID, "baby_id": nil, "title": "新对话", "context_type": "general",
		"created_at": testTime, "updated_at": testTime}
	session := webAISessionDTO(sessionRow, nil, 0, nil)
	message := webAIMessageDTO(Object{"id": testUUID, "session_id": testUUID, "role": "user", "content": "", "created_at": testTime})
	formula := formulaProductDTO(Object{"id": testUUID, "family_id": testUUID, "brand": "test_brand", "name": "test_formula",
		"scoop_weight_g": json.Number("0.00000"), "water_per_scoop_ml": json.Number("30.00000"),
		"serving_size_unit": "per_100g", "is_active": true, "is_default": false, "is_archived": false,
		"created_at": testTime, "updated_at": testTime})
	for _, tc := range []struct {
		method, path string
		status       int
		body         any
	}{
		{"GET", "/api/v1/notifications", 200, page([]Object{notification}, nil)},
		{"GET", "/api/v1/notifications", 200, page([]Object{}, nil)},
		{"POST", "/api/v1/voice/logs", 201, envelope(voice)},
		{"GET", "/api/v1/voice/logs", 200, envelope(nil)},
		{"GET", "/api/v1/voice/logs", 200, envelope(voice)},
		{"GET", "/api/v1/voice/logs", 200, page([]Object{}, nil)},
		{"POST", "/api/v1/web/ai/sessions", 201, envelope(session)},
		{"GET", "/api/v1/web/ai/sessions", 200, envelope(Object{"total": 0, "sessions": []Object{}})},
		{"POST", "/api/v1/web/ai/sessions/" + testUUID + "/messages", 201, envelope(message)},
		{"POST", "/api/v1/families/" + testUUID + "/nutrition/products", 201, envelope(formula)},
		{"GET", "/api/v1/families/" + testUUID + "/nutrition/products", 200, page([]Object{}, nil)},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			route, _ := contract.Match(tc.method, tc.path)
			if route == nil {
				t.Fatal("missing route")
			}
			raw, err := jsonBytes(tc.body)
			if err != nil {
				t.Fatal(err)
			}
			var wire any
			if err = decodeJSON(raw, &wire); err != nil {
				t.Fatal(err)
			}
			if err = route.ValidateResponse(context.Background(), tc.status, wire); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCompanionNullAndDecimalSemantics(t *testing.T) {
	n := notificationDTO(Object{"data": nil})
	if _, present := n["data"]; present {
		t.Fatal("null notification data must be omitted")
	}
	n = notificationDTO(Object{"data": Object{}})
	if _, present := n["data"]; !present {
		t.Fatal("an empty object must remain present")
	}
	s := webAISessionDTO(Object{}, nil, 0, nil)
	if s["messages"] == nil || !reflect.DeepEqual(s["messages"], []Object{}) || s["lastMessage"] != nil {
		t.Fatal("session collections must use [] and lastMessage:null")
	}
	f := formulaProductDTO(Object{"scoop_weight_g": json.Number("0.00000"), "water_per_scoop_ml": json.Number("30.50000")})
	if f["scoopGrams"] != "0" || f["waterMlPerScoop"] != "30.5" || f["reconstitutionRatio"] != nil {
		t.Fatal("decimal zero and null must remain distinct")
	}
	if _, exists := f["version"]; exists {
		t.Fatal("do not add version metadata to the legacy formula DTO")
	}
}

func TestCompanionCursorValidation(t *testing.T) {
	valid := encodeCareCursor(testTime, testUUID)
	clock, id, err := companionCursor(valid, "INVALID_CURSOR")
	if err != nil || iso(clock) != testTime || id != testUUID {
		t.Fatal("cursor round-trip failed", err)
	}
	for _, payload := range []string{"", "invalid|id", testTime + "|", testTime + "|id|extra", testTime + "|../id"} {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
		if _, _, err := companionCursor(encoded, "INVALID_NOTIFICATION_CURSOR"); err == nil || normalizedError(err).Code != "INVALID_NOTIFICATION_CURSOR" {
			t.Fatalf("unsafe cursor accepted: %q", payload)
		}
	}
}

func TestWebAIMessageReplay(t *testing.T) {
	row := Object{"id": testUUID, "session_id": testUUID, "role": "user", "content": "你好", "image": nil, "tools_json": nil, "created_at": testTime}
	body := Object{"id": testUUID, "role": "user", "content": "你好"}
	result, err := webAIReplay(row, testUUID, body)
	if err != nil || result.Status != http.StatusCreated {
		t.Fatal("exact message replay failed", err)
	}
	for _, change := range []Object{{"content": "different"}, {"role": "assistant"}, {"image": ""}, {"toolsJson": "{}"}} {
		altered := copyObject(body)
		for key, value := range change {
			altered[key] = value
		}
		if _, err = webAIReplay(row, testUUID, altered); err == nil || normalizedError(err).Code != "MESSAGE_ID_REUSED" {
			t.Fatal("changed message replay accepted")
		}
	}
	if _, err = webAIReplay(row, "different-session", body); err == nil {
		t.Fatal("cross-session message ID accepted")
	}
}

func TestFormulaFieldAllowlistAndPatch(t *testing.T) {
	values, err := formulaProductValues(Object{"stage": nil, "isArchived": true, "familyId": "attacker", "version": 99, "notes": "ignored by reference"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, Object{"stage": nil, "is_archived": true}) {
		t.Fatalf("unexpected SQL fields: %v", values)
	}
	values, err = formulaProductValues(Object{}, false)
	if err != nil || len(values) != 0 {
		t.Fatal("absent patch fields must remain absent")
	}
}

func TestCompanionQueryBounds(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  int
	}{{"", 20}, {"?limit=1", 1}, {"?limit=0", 1}, {"?limit=200", 100}, {"?limit=invalid", 20}} {
		r := &Request{HTTP: httptest.NewRequest(http.MethodGet, "/"+tc.query, nil)}
		if got := companionLimit(r, 20, 100); got != tc.want {
			t.Fatalf("%s: got %d, want %d", tc.query, got, tc.want)
		}
	}
}
