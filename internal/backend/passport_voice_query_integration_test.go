package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type passportVoiceQueryProviderObservation struct {
	body             []byte
	authorizedMarker bool
	foreignMarker    bool
}

// This is an isolated end-to-end feedback loop for the exact symptom: a
// committed, authorized record exists, but the model answers that no record is
// available. Its PostgreSQL rows are created through the real confirmation
// transaction and its voice request passes the Passport JWT/WebSocket handler.
func TestPassportVoiceRecordQueryContextDiagnostic(t *testing.T) {
	clearSpeechTestEnvironment(t)
	for _, name := range []string{
		"GROWDESK_TTS_PROVIDER", "GROWDESK_TTS_BASE_URL", "GROWDESK_TTS_API_KEY",
		"GROWDESK_TTS_MODEL", "GROWDESK_TTS_VOICE", "GROWDESK_TTS_TIMEOUT_MS",
	} {
		t.Setenv(name, "")
	}

	const authorizedAnswer = "test_one_authorized_record"
	const noDataAnswer = "test_no_record_context"
	authorizedMarker := "test_passport_voice_query_authorized_" + strings.ReplaceAll(newID(), "-", "")
	foreignMarker := "test_passport_voice_query_foreign_" + strings.ReplaceAll(newID(), "-", "")
	observations := make(chan passportVoiceQueryProviderObservation, 2)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/audio/transcriptions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"text":"今天宝宝喝了多少奶？"}`)
		case "/v1/chat/completions":
			body, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024))
			if err != nil {
				http.Error(w, "test provider could not read request", http.StatusBadRequest)
				return
			}
			authorized := bytes.Contains(body, []byte(authorizedMarker))
			foreign := bytes.Contains(body, []byte(foreignMarker))
			observations <- passportVoiceQueryProviderObservation{body: body, authorizedMarker: authorized, foreignMarker: foreign}
			answer := noDataAnswer
			if authorized && !foreign {
				answer = authorizedAnswer
			}
			content, _ := json.Marshal(Object{"text": answer, "actions": []any{}})
			response := Object{"choices": []any{Object{"message": Object{"content": string(content)}}}}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(response)
		case "/v1/audio/speech":
			w.Header().Set("Content-Type", "audio/pcm; rate=24000; channels=1; bits=16; endianness=little")
			_, _ = w.Write([]byte{0, 0})
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()

	t.Setenv("GROWDESK_AI_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_AI_BASE_URL", provider.URL+"/v1")
	t.Setenv("GROWDESK_AI_API_KEY", "test_local_query_ai_key")
	t.Setenv("GROWDESK_AI_MODEL", "test_local_query_model")
	t.Setenv("GROWDESK_ASR_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_ASR_BASE_URL", provider.URL+"/v1")
	t.Setenv("GROWDESK_ASR_API_KEY", "test_local_query_asr_key")
	t.Setenv("GROWDESK_ASR_MODEL", "test_local_query_asr")
	t.Setenv("GROWDESK_TTS_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_TTS_BASE_URL", provider.URL+"/v1")
	t.Setenv("GROWDESK_TTS_API_KEY", "test_local_query_tts_key")

	h := newPassportConfirmationPG(t)
	fx := newPassportConfirmationFixture(t, h.controlDB)
	other := newPassportConfirmationFixture(t, h.controlDB)
	if _, err := h.controlDB.Exec(context.Background(), `UPDATE families SET timezone='America/Los_Angeles' WHERE id=$1`, fx.familyID); err != nil {
		t.Fatalf("set isolated family timezone: %v", err)
	}
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	recordedAt := time.Now().In(location).Format(time.RFC3339Nano)
	createRecord := func(fixture *passportConfirmationFixture, amount, note string) string {
		t.Helper()
		actionID, runID := newID(), newID()
		planHash := "test_plan_" + newID()
		action := nativeAIAction{
			ActionID: actionID, EntityType: "feeding", Operation: "create",
			Summary: "Test Passport feeding record",
			Payload: Object{"feedingType": "formula", "amountMl": amount, "occurredAt": recordedAt, "notes": note},
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		id, err := h.server.executePassportCardConfirmation(ctx, fixture.principal, runID, planHash, actionID, planHash, action, time.Now().Add(2*time.Minute))
		if err != nil || id == "" {
			t.Fatalf("seed isolated Passport record through confirmation transaction: id=%q err=%v", id, err)
		}
		return id
	}
	createdID := createRecord(fx, "145.5", authorizedMarker)
	foreignID := createRecord(other, "999", foreignMarker)
	var note string
	if err := h.controlDB.QueryRow(context.Background(), `SELECT notes FROM feeding_records WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL`, createdID, fx.familyID, fx.babyID).Scan(&note); err != nil || note != authorizedMarker {
		t.Fatalf("verify committed authorized test row before voice query: note=%q err=%v", note, err)
	}
	if err := h.controlDB.QueryRow(context.Background(), `SELECT notes FROM feeding_records WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND deleted_at IS NULL`, foreignID, other.familyID, other.babyID).Scan(&note); err != nil || note != foreignMarker {
		t.Fatalf("verify committed foreign-family test row before voice query: note=%q err=%v", note, err)
	}
	loadedContext, loadErr := h.server.loadPassportVoiceRecordContextForKinds(context.Background(), fx.principal, time.Now().UTC(), []string{"feeding"})
	if loadErr != nil {
		t.Fatalf("direct read of authorized Passport record context failed: %v", loadErr)
	}
	if !loadedContext.HasAnyRecords || loadedContext.TotalRecordCount != 1 || loadedContext.RecentRecordCount != 1 {
		t.Fatalf("authorized test record context counts = total %d recent %d", loadedContext.TotalRecordCount, loadedContext.RecentRecordCount)
	}
	t.Logf("loaded read context: total=%d recent=%d truncated=%t timezone=%s", loadedContext.TotalRecordCount, loadedContext.RecentRecordCount, loadedContext.Truncated, loadedContext.TimeZone)

	const jwtSecret = "test_passport_record_query_signing_key"
	h.server.Config.JWTSecret = jwtSecret
	token := passportShortTurnTestToken(t, fx, jwtSecret)
	wsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/passport/ws" {
			http.NotFound(w, r)
			return
		}
		result, err := h.server.handlePassportWebSocket(r.Context(), &Request{HTTP: r})
		if err != nil {
			h.server.writeError(w, err, "test_passport_voice_query_context")
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
	wsURL := "ws" + strings.TrimPrefix(wsServer.URL, "http") + "/api/v1/passport/ws"
	conn, response, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Authorization": []string{"Bearer " + token}})
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		t.Fatalf("connect through real Passport JWT/WebSocket handler: %v", err)
	}
	defer conn.Close()

	// One short but non-silent device frame stays below the real 16 KiB WS limit.
	pcm := make([]byte, 1600)
	pcm[0] = 1
	sendPassportTestVoiceTurn(t, conn, "test_voice_query_today", pcm)
	asr := readPassportTestWSEvent(t, conn)
	if asr["type"] != "asr.final" || asr["text"] != "今天宝宝喝了多少奶？" {
		t.Fatalf("isolated voice query ASR result = %#v", asr)
	}
	answer := readPassportTestWSEvent(t, conn)
	if answer["type"] != "assistant.final" {
		t.Fatalf("isolated voice query did not produce assistant.final: %#v", answer)
	}
	var observed passportVoiceQueryProviderObservation
	select {
	case observed = <-observations:
	case <-time.After(2 * time.Second):
		t.Fatal("local fake chat provider did not receive the voice query")
	}
	if !observed.authorizedMarker || observed.foreignMarker || answer["text"] != authorizedAnswer {
		t.Fatalf("voice query returned %q although an authorized test feeding row was committed; provider_payload_has_authorized_record=%t provider_payload_has_foreign_family_record=%t", answer["text"], observed.authorizedMarker, observed.foreignMarker)
	}
}
