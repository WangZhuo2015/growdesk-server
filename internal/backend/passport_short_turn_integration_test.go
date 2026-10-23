package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

func TestPassportShortTurnWebSocketIntegration(t *testing.T) {
	t.Setenv("GROWDESK_ASR_PROVIDER", "")
	t.Setenv("ASR_COMMAND", "")
	t.Setenv("GROWDESK_ASR_FIXTURE_TEXT", "，。？！…")
	t.Setenv("GROWDESK_AI_PROVIDER", "fixture")
	actionID := newID()
	aiFixture, err := json.Marshal(Object{
		"text": "test fixture answer",
		"actions": []any{Object{
			"actionId": actionID, "entityType": "feeding", "operation": "create",
			"summary": "test feeding proposal",
			"payload": Object{"feedingType": "formula", "occurredAt": time.Now().UTC().Format(time.RFC3339)},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GROWDESK_AI_FIXTURE_RESPONSE", string(aiFixture))
	t.Setenv("GROWDESK_AI_TIMEOUT_MS", "")
	t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
	t.Setenv("GROWDESK_TTS_BASE_URL", "")
	t.Setenv("GROWDESK_TTS_API_KEY", "")
	t.Setenv("GROWDESK_TTS_TIMEOUT_MS", "")

	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	const jwtSecret = "test_passport_short_turn_signing_key"
	h.server.Config.JWTSecret = jwtSecret
	token := passportShortTurnTestToken(t, fx, jwtSecret)
	wsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/passport/ws" {
			http.NotFound(w, r)
			return
		}
		result, err := h.server.handlePassportWebSocket(r.Context(), &Request{HTTP: r})
		if err != nil {
			h.server.writeError(w, err, "test_passport_short_turn")
			return
		}
		if result.Stream == nil {
			http.Error(w, "websocket stream missing", http.StatusInternalServerError)
			return
		}
		if err := result.Stream(w); err != nil {
			return
		}
	}))
	defer wsServer.Close()

	headers := http.Header{"Authorization": []string{"Bearer " + token}}
	wsURL := "ws" + strings.TrimPrefix(wsServer.URL, "http") + "/api/v1/passport/ws"
	conn, response, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		t.Fatalf("connect through real Passport auth handler: %v", err)
	}
	defer conn.Close()

	// 50 ms of nonzero PCM passes the byte-duration gate and reaches the explicit
	// ASR fixture, which returns punctuation only.
	shortPCM := make([]byte, 1600)
	shortPCM[0] = 1
	sendPassportTestVoiceTurn(t, conn, "test_short_turn_one", shortPCM)
	firstError := readPassportTestWSEvent(t, conn)
	if firstError["type"] != "error" || firstError["code"] != "ASR_PROVIDER_NO_SPEECH" || firstError["turnId"] != "test_short_turn_one" {
		t.Fatalf("punctuation-only ASR response = %#v; want turn-scoped ASR_PROVIDER_NO_SPEECH", firstError)
	}
	assertNoPassportVoiceHistoryWrites(t, ctx, h, fx)

	// The same authenticated connection must continue to process control frames,
	// answer hello, and handle another recording rather than requiring reconnect.
	pong := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error {
		select {
		case pong <- struct{}{}:
		default:
		}
		return nil
	})
	if err := conn.WriteControl(websocket.PingMessage, []byte("test_ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatalf("send websocket ping after rejected turn: %v", err)
	}
	if err := conn.WriteJSON(Object{"v": 1, "type": "hello"}); err != nil {
		t.Fatalf("send hello after rejected turn: %v", err)
	}
	ready := readPassportTestWSEvent(t, conn)
	if ready["type"] != "ready" || ready["deviceId"] != fx.deviceID {
		t.Fatalf("same-socket hello response = %#v; want current device READY", ready)
	}
	select {
	case <-pong:
	case <-time.After(time.Second):
		t.Fatal("server did not pong on the authenticated socket after the rejected turn")
	}

	// A well-formed next turn with exact digital silence also returns a bounded
	// no-speech response on this socket; no AI/history/card work should occur.
	sendPassportTestVoiceTurn(t, conn, "test_short_turn_two", make([]byte, 1600))
	secondError := readPassportTestWSEvent(t, conn)
	if secondError["type"] != "error" || secondError["code"] != "ASR_PROVIDER_NO_SPEECH" || secondError["turnId"] != "test_short_turn_two" {
		t.Fatalf("second same-socket turn response = %#v; want turn-scoped ASR_PROVIDER_NO_SPEECH", secondError)
	}
	assertNoPassportVoiceHistoryWrites(t, ctx, h, fx)

	if err := conn.WriteJSON(Object{"v": 1, "type": "hello"}); err != nil {
		t.Fatalf("send second hello after no-speech turn: %v", err)
	}
	if got := readPassportTestWSEvent(t, conn); got["type"] != "ready" {
		t.Fatalf("same-socket READY after second turn = %#v", got)
	}
}

func passportShortTurnTestToken(t *testing.T, fx *passportConfirmationFixture, secret string) string {
	t.Helper()
	now := time.Now().UTC()
	claims := jwt.MapClaims{
		"sub": fx.deviceID, "deviceId": fx.deviceID, "typ": "passport+jwt",
		"iss": "growdesk-passport", "aud": "growdesk-voice-gateway",
		"uid": fx.userID, "fid": fx.familyID, "bid": fx.babyID,
		"scopes": []string{"passport:connect", "passport:voice", "passport:agent"},
		"iat":    now.Unix(), "exp": now.Add(10 * time.Minute).Unix(),
		"jti": "test_passport_short_turn_" + strings.ReplaceAll(newID(), "-", ""),
	}
	raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func sendPassportTestVoiceTurn(t *testing.T, conn *websocket.Conn, turnID string, pcm []byte) {
	t.Helper()
	if err := conn.WriteJSON(Object{"v": 1, "type": "audio.start", "turnId": turnID}); err != nil {
		t.Fatalf("send %s start: %v", turnID, err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, pcm); err != nil {
		t.Fatalf("send %s PCM: %v", turnID, err)
	}
	if err := conn.WriteJSON(Object{"v": 1, "type": "audio.end", "turnId": turnID}); err != nil {
		t.Fatalf("send %s end: %v", turnID, err)
	}
}

func readPassportTestWSEvent(t *testing.T, conn *websocket.Conn) Object {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var event Object
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatalf("read Passport websocket event: %v", err)
	}
	return event
}

func assertNoPassportVoiceHistoryWrites(t *testing.T, ctx context.Context, h *passportConfirmationPG, fx *passportConfirmationFixture) {
	t.Helper()
	var count int
	err := h.controlDB.QueryRow(ctx, `SELECT count(*) FROM ai_messages m
		JOIN ai_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND s.baby_id=$2`, fx.userID, fx.babyID).Scan(&count)
	if err != nil {
		t.Fatalf("count isolated Passport voice history messages: %v", err)
	}
	if count != 0 {
		t.Fatalf("no-speech turns wrote %d AI/history messages before confirmation", count)
	}
}
