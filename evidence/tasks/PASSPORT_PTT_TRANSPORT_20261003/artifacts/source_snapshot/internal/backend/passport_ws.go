package backend

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16384,
	WriteBufferSize: 16384,
	CheckOrigin: func(r *http.Request) bool {
		return true // Device authentication is strictly verified via Bearer token
	},
}

type pendingCardProposal struct {
	RunID     string
	PlanHash  string
	Action    nativeAIAction
	ExpiresAt time.Time
}

func passportCardPresentEvent(turnID, runID string, card PassportCard, planHash, actionID string, expiresAt time.Time) Object {
	return Object{
		"v":      1,
		"type":   "card.present",
		"turnId": turnID,
		"runId":  runID,
		"card":   card,
		"confirmation": Object{
			"planHash":  planHash,
			"actionIds": []string{actionID},
			"expiresAt": expiresAt.Format(time.RFC3339),
		},
	}
}

type passportCardProjection struct {
	Action   nativeAIAction
	Card     PassportCard
	PlanHash string
}

func (s *Server) projectValidatedPassportActions(actions []nativeAIAction) (*passportCardProjection, error) {
	if len(actions) != 1 {
		return projectPassportActions(actions)
	}
	action, card, err := s.normalizeValidatePassportAction(actions[0])
	if err != nil {
		return nil, err
	}
	projection, err := projectPassportActions([]nativeAIAction{action})
	if projection != nil {
		projection.Card = card
	}
	return projection, err
}

// Passport currently displays and confirms one action. Reject a multi-action
// plan before projecting a partial card or persisting pending confirmation.
func projectPassportActions(actions []nativeAIAction) (*passportCardProjection, error) {
	if len(actions) > 1 {
		return nil, providerFailure("MULTI_ACTION_UNSUPPORTED",
			"Passport can confirm one record at a time. Please submit one record at a time.", false)
	}
	if len(actions) == 0 {
		return nil, nil
	}

	action := actions[0]
	card, err := projectActionToCard(action)
	if err != nil {
		return nil, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "Record proposal cannot be displayed faithfully", false)
	}
	planHash, err := canonicalNativeHash([]any{Object{
		"actionId":   action.ActionID,
		"entityType": action.EntityType,
		"operation":  action.Operation,
		"summary":    action.Summary,
		"payload":    action.Payload,
	}})
	if err != nil {
		return nil, err
	}
	return &passportCardProjection{Action: action, Card: card, PlanHash: planHash}, nil
}

func (s *Server) handlePassportWebSocket(ctx context.Context, r *Request) (Result, error) {
	// 1. Query parameter check: FORBIDDEN per Section 七
	if r.HTTP.URL.Query().Get("token") != "" || r.HTTP.URL.Query().Get("access_token") != "" {
		return Result{}, apiError(http.StatusBadRequest, "TOKEN_IN_QUERY_FORBIDDEN", "Authorization token must not be sent in URL query parameters")
	}

	// 2. Strict Authorization Header check
	authHeader := r.HTTP.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return Result{}, apiError(http.StatusUnauthorized, "UNAUTHORIZED", "Missing or malformed Authorization header")
	}
	tokenString := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))

	principal, err := s.AuthenticatePassport(ctx, tokenString)
	if err != nil {
		return Result{}, err
	}

	return Result{
		Status: http.StatusSwitchingProtocols,
		Stream: func(w http.ResponseWriter) error {
			conn, err := upgrader.Upgrade(w, r.HTTP, nil)
			if err != nil {
				s.Log.Error("websocket upgrade failed", "error", err)
				return err
			}
			defer conn.Close()

			return s.runPassportWebSocketLoop(ctx, conn, principal)
		},
	}, nil
}

func (s *Server) runPassportWebSocketLoop(ctx context.Context, conn *websocket.Conn, principal *PassportPrincipal) error {
	configurePassportSocket(conn)
	ctx, cancel := context.WithDeadline(ctx, principal.ExpiresAt)
	defer cancel()
	// Closing the socket also wakes an idle ReadMessage at token expiration.
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	var writeMu sync.Mutex
	sendJSON := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return err
		}
		return conn.WriteJSON(v)
	}
	sendBinary := func(data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return err
		}
		return conn.WriteMessage(websocket.BinaryMessage, data)
	}
	sendAccessError := func(err error) {
		code, message := "AUTHORIZATION_FAILED", "Unable to verify current device access"
		var appErr *APIError
		if errors.As(err, &appErr) {
			code, message = appErr.Code, appErr.Message
		}
		_ = sendJSON(Object{"v": 1, "type": "error", "code": code, "message": message})
	}

	// 1. Load baby name from DB
	var babyName string
	err := s.DB.QueryRow(ctx, `SELECT name FROM babies WHERE id = $1`, principal.BabyID).Scan(&babyName)
	if err != nil {
		babyName = "宝宝"
	}

	// 2. Load or create active AI session for device + baby
	sessionID, err := s.getOrCreatePassportAISession(ctx, principal)
	if err != nil {
		s.Log.Error("failed to get or create passport session", "error", err)
	}

	// Active turn state
	var (
		currentTurnID   string
		currentAudioBuf bytes.Buffer
		isRecording     bool
		currentPending  passportPending[pendingCardProposal]
		playback        passportPlaybackControl
		turnGate        passportTurnGate
		currentTurn     *passportTurnTicket
		seenTurns       passportReplay
	)

	stopTTS := playback.stop
	defer func() {
		turnGate.stop()
		stopTTS()
	}()

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			stopTTS()
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return nil
			}
			return err
		}

		if messageType == websocket.BinaryMessage {
			// Incoming voice stream PCM chunk
			if isRecording {
				// Hard limit: 960KB (~30 seconds of 16kHz mono S16LE)
				if currentAudioBuf.Len()+len(message) > 960*1024 {
					isRecording = false
					_ = sendJSON(Object{
						"v":       1,
						"type":    "error",
						"code":    "VOICE_TOO_LONG",
						"message": "Voice input exceeded 30 seconds limit",
					})
				} else {
					currentAudioBuf.Write(message)
				}
			}
			continue
		}

		if messageType != websocket.TextMessage {
			continue
		}

		// Text control frame (JSON)
		var frame Object
		if err := decodeJSON(message, &frame); err != nil {
			_ = sendJSON(Object{"v": 1, "type": "error", "code": "INVALID_FRAME", "message": "Malformed JSON"})
			continue
		}

		frameType := text(frame["type"])
		switch frameType {
		case "hello":
			_ = sendJSON(Object{
				"v":        1,
				"type":     "ready",
				"deviceId": principal.DeviceID,
				"baby": Object{
					"id":   principal.BabyID,
					"name": babyName,
				},
			})

		case "audio.start":
			if err := s.requirePassportTurnAccess(ctx, principal); err != nil {
				sendAccessError(err)
				return err
			}
			// User pressed OK button to start talking
			turnID := text(frame["turnId"])
			if turnID == "" {
				turnID = newID()
			}
			accepted, idErr := seenTurns.accept(turnID)
			if idErr != nil {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "INVALID_TURN_ID", "message": "Voice turn ID is too long"})
				continue
			}
			if !accepted {
				// Idempotency: ignore duplicate turnId
				continue
			}
			stopTTS() // Only an accepted new turn interrupts playback.
			currentTurn = turnGate.replace(ctx)
			currentPending.store(nil)
			currentTurnID = turnID
			currentAudioBuf.Reset()
			isRecording = true

		case "audio.end":
			// User released OK button
			if !isRecording {
				continue
			}
			if err := s.requirePassportTurnAccess(ctx, principal); err != nil {
				sendAccessError(err)
				return err
			}
			turnID, endErr := passportAudioEndTurn(currentTurnID, text(frame["turnId"]))
			if endErr != nil {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "INVALID_TURN_ID", "message": "Audio end does not match the active recording"})
				continue
			}
			isRecording = false

			pcmData := currentAudioBuf.Bytes()
			if len(pcmData) < 1600 { // less than ~50ms of audio
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "VOICE_TOO_SHORT", "message": "Voice input was too short"})
				continue
			}

			// Wrap PCM in temporary WAV format for ASR
			wavData := buildWavFile(pcmData, 16000, 1, 16)

			// Process ASR and Agent asynchronously to avoid blocking websocket read loop
			go func(ticket *passportTurnTicket, tID string, wavBytes []byte) {
				s.processVoiceTurn(ticket.ctx, principal, sessionID, babyName, tID, wavBytes, sendJSON, sendBinary, &playback, ticket, &currentPending)
			}(currentTurn, turnID, wavData)

		case "card.confirm":
			runID := text(frame["runId"])
			planHash := text(frame["planHash"])
			pending := currentPending.load()

			if pending == nil || pending.RunID != runID {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "NO_PENDING_PROPOSAL", "message": "No active proposal card found"})
				continue
			}

			actionID, err := passportConfirmedActionID(frame["actionIds"], pending.Action.ActionID)
			if err != nil {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "INVALID_CONFIRMATION", "message": err.Error()})
				continue
			}

			recordID, err := s.executePassportCardConfirmation(ctx, principal, runID, planHash, actionID, pending.PlanHash, pending.Action, pending.ExpiresAt)
			if err != nil {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "CONFIRM_FAILED", "message": err.Error()})
			} else {
				currentPending.clear(pending)
				_ = sendJSON(Object{
					"v":          1,
					"type":       "card.saved",
					"runId":      runID,
					"entityType": currentPendingEntityType(pending),
					"recordId":   recordID,
				})
			}

		case "tts.interrupt":
			stopTTS()
		}
	}
}

func currentPendingEntityType(p *pendingCardProposal) string {
	if p != nil {
		return p.Action.EntityType
	}
	return "feeding"
}

func (s *Server) getOrCreatePassportAISession(ctx context.Context, principal *PassportPrincipal) (string, error) {
	var sessionID string
	err := s.DB.QueryRow(ctx, `SELECT id FROM ai_sessions WHERE user_id = $1 AND baby_id = $2 ORDER BY updated_at DESC LIMIT 1`,
		principal.OwnerUserID, principal.BabyID).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		sessionID = newID()
		_, err = s.DB.Exec(ctx, `INSERT INTO ai_sessions(id, user_id, baby_id, title, created_at, updated_at)
			VALUES($1, $2, $3, 'Passport Companion', NOW(), NOW())`, sessionID, principal.OwnerUserID, principal.BabyID)
		if err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	return sessionID, nil
}

func (s *Server) processVoiceTurn(
	ctx context.Context,
	principal *PassportPrincipal,
	sessionID, babyName, turnID string,
	wavBytes []byte,
	sendJSON func(any) error,
	sendBinary func([]byte) error,
	playback *passportPlaybackControl,
	ticket *passportTurnTicket,
	pendingOut *passportPending[pendingCardProposal],
) {
	if ctx.Err() != nil {
		return
	}
	publication := func(scope context.Context, fn func() error) error {
		if ticket != nil {
			return ticket.publish(scope, fn)
		}
		if scope.Err() != nil {
			return scope.Err()
		}
		return fn()
	}
	rawJSON, rawBinary := sendJSON, sendBinary
	sendJSON = func(value any) error {
		if event, ok := value.(Object); ok && event["type"] == "error" {
			event["turnId"] = turnID
		}
		return publication(ctx, func() error { return rawJSON(value) })
	}
	sendBinary = func(value []byte) error { return publication(ctx, func() error { return rawBinary(value) }) }
	// The device waits 60 seconds for a response. Bound recognition + agent work
	// below that budget so an old job cannot complete after the device retries.
	processingCtx, stopProcessing := context.WithTimeout(ctx, 55*time.Second)
	defer stopProcessing()
	speechConfig, err := nativeSpeechConfiguration()
	if err != nil {
		_ = sendJSON(passportASRErrorEvent(err))
		return
	}

	// 1. Transcribe Audio
	transcript, err := s.transcribePassportWav(processingCtx, speechConfig, wavBytes)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		_ = sendJSON(passportASRErrorEvent(err))
		return
	}

	if processingCtx.Err() != nil {
		return
	}
	_ = sendJSON(Object{
		"v":      1,
		"type":   "asr.final",
		"turnId": turnID,
		"text":   transcript,
	})
	config, err := nativeProviderConfiguration()
	if err != nil {
		_ = sendJSON(passportAIErrorEvent(err))
		return
	}
	var catalog []Object
	if s.DB != nil {
		catalog, err = s.loadPassportVoiceCatalog(processingCtx, principal)
		if err != nil {
			code := "VOICE_CONTEXT_UNAVAILABLE"
			var scopeErr *APIError
			if errors.As(err, &scopeErr) && (scopeErr.Status == 401 || scopeErr.Status == 403) {
				code = scopeErr.Code
			}
			_ = sendJSON(Object{"v": 1, "type": "error", "code": code, "message": "Voice context is unavailable; reconnect or pair the device again"})
			return
		}
	}

	// 2. Append User Message
	if sessionID != "" {
		_, _ = s.DB.Exec(processingCtx, `INSERT INTO ai_messages(id, session_id, role, content, created_at) VALUES($1, $2, 'user', $3, NOW())`,
			newID(), sessionID, transcript)
	}

	// 3. Load bounded history (recent 12 messages, max 32KB)
	historyMessages := s.loadBoundedSessionHistory(processingCtx, sessionID, 12, 32*1024)

	// 4. Call Cloud Agent
	runID := newID()
	agentResult, err := s.callPassportAgent(processingCtx, config, sessionID, principal.BabyID, babyName, transcript, historyMessages, catalog)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		_ = sendJSON(passportAIErrorEvent(err))
		return
	}

	// A replaced/cancelled turn must not publish an answer or proposal.
	if processingCtx.Err() != nil {
		return
	}

	// 5. Send Assistant text
	if agentResult.Text != "" {
		_ = sendJSON(Object{
			"v":      1,
			"type":   "assistant.final",
			"turnId": turnID,
			"text":   agentResult.Text,
		})
		if sessionID != "" {
			_, _ = s.DB.Exec(processingCtx, `INSERT INTO ai_messages(id, session_id, role, content, created_at) VALUES($1, $2, 'assistant', $3, NOW())`,
				newID(), sessionID, agentResult.Text)
		}
	}

	if processingCtx.Err() != nil {
		return
	}

	// 6. Project Proposals to Cards. Passport supports one action per card;
	// never display/confirm only the first item from a larger plan.
	projection, projectionErr := s.projectValidatedPassportActions(agentResult.Actions)
	if projectionErr == nil && projection != nil && projection.Action.EntityType == "food" {
		projectionErr = s.hydratePassportFoodCard(processingCtx, principal, projection)
	}
	if projectionErr != nil {
		code, message := "CARD_PROJECTION_FAILED", "Unable to prepare a record proposal. Please try again."
		var providerErr *nativeProviderError
		if errors.As(projectionErr, &providerErr) {
			code, message = providerErr.Code, providerErr.Message
		}
		_ = sendJSON(Object{"v": 1, "type": "error", "code": code, "message": message})
		return
	} else if projection != nil {
		expiry := time.Now().Add(2 * time.Minute)
		if err := publication(processingCtx, func() error {
			pendingOut.store(&pendingCardProposal{
				RunID:     runID,
				PlanHash:  projection.PlanHash,
				Action:    projection.Action,
				ExpiresAt: expiry,
			})

			return rawJSON(passportCardPresentEvent(turnID, runID, projection.Card,
				projection.PlanHash, projection.Action.ActionID, expiry))
		}); err != nil {
			return
		}
	}

	// 7. TTS Streaming (Half-duplex)
	if agentResult.Text != "" {
		ttsCtx, endPlayback := playback.start(ctx)
		defer endPlayback()

		s.streamPassportTTS(ttsCtx, config, turnID, agentResult.Text, sendJSON, sendBinary)
	}
}

func passportASRErrorEvent(err error) Object {
	code, message := "ASR_FAILED", "Voice recognition failed"
	if errors.Is(err, context.DeadlineExceeded) {
		return Object{"v": 1, "type": "error", "code": "ASR_PROVIDER_TIMEOUT", "message": "Speech recognition timed out"}
	}
	var providerErr *nativeProviderError
	if errors.As(err, &providerErr) && strings.HasPrefix(providerErr.Code, "ASR_PROVIDER_") {
		code, message = providerErr.Code, providerErr.Message
	}
	return Object{"v": 1, "type": "error", "code": code, "message": message}
}

func (s *Server) loadBoundedSessionHistory(ctx context.Context, sessionID string, maxCount int, maxBytes int) []Object {
	if sessionID == "" {
		return nil
	}

	rows, err := s.DB.Query(ctx, `SELECT role, content FROM ai_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`, sessionID, maxCount)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var reversed []Object
	totalBytes := 0
	for rows.Next() {
		var role, content string
		if err := rows.Scan(&role, &content); err == nil {
			msgBytes := len(role) + len(content)
			if totalBytes+msgBytes > maxBytes {
				break
			}
			totalBytes += msgBytes
			reversed = append(reversed, Object{"role": role, "content": content})
		}
	}

	// Reverse to chronological order
	var out []Object
	for i := len(reversed) - 1; i >= 0; i-- {
		out = append(out, reversed[i])
	}
	return out
}

func (s *Server) callPassportAgent(ctx context.Context, c nativeProviderConfig, sessionID, babyID, babyName, userMessage string, history []Object, catalogs ...[]Object) (nativeAIResult, error) {
	if c.Mode == "fixture" {
		if err := ctx.Err(); err != nil {
			return nativeAIResult{}, err
		}
		if c.Fixture == "" {
			return nativeAIResult{}, providerFailure("AI_PROVIDER_NOT_CONFIGURED", "Explicit fixture content is required", false)
		}
		return parsePassportAssistant(c.Fixture)
	}

	// OpenAI-compatible call with structured tool/system prompt
	systemPrompt := passportAgentSystemPrompt(babyName, time.Now(), catalogs...)

	var messages []Object
	messages = append(messages, Object{"role": "system", "content": systemPrompt})
	messages = append(messages, history...)
	messages = append(messages, Object{"role": "user", "content": userMessage})

	requestBody := Object{
		"model":    c.Model,
		"messages": messages,
		"metadata": Object{
			"sessionId": sessionID,
			"babyId":    babyID,
		},
	}

	raw, err := jsonBytes(requestBody)
	if err != nil {
		return nativeAIResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint, bytes.NewReader(raw))
	if err != nil {
		return nativeAIResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	client := providerHTTPClient(c.Timeout)
	defer client.CloseIdleConnections()

	response, err := providerReadJSONFor(ctx, client, req, "AI")
	if err != nil {
		return nativeAIResult{}, err
	}
	choices, ok := response["choices"].([]any)
	if !ok || len(choices) == 0 {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned no choices", false)
	}
	content, ok := obj(obj(choices[0])["message"])["content"].(string)
	if !ok {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned no assistant text", false)
	}
	answer, err := parsePassportAssistant(content)
	if err != nil {
		return answer, err
	}
	if len(answer.Text) > 256*1024 || (strings.TrimSpace(answer.Text) == "" && len(answer.Actions) == 0) {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned an empty or oversized answer", false)
	}
	return answer, nil
}

func (s *Server) transcribePassportWav(ctx context.Context, c nativeProviderConfig, wavBytes []byte) (string, error) {
	if len(wavBytes) == 0 || len(wavBytes) > 960*1024+44 {
		return "", providerFailure("ASR_INPUT_TOO_LARGE", "Voice input is empty or exceeds the device audio budget", false)
	}
	if passportWavIsDigitalSilence(wavBytes) {
		return "", providerFailure("ASR_PROVIDER_NO_SPEECH", "No sound was recorded; hold the middle key and speak again", false)
	}
	if c.Mode == "local" {
		local, enabled, err := localASRConfiguration()
		if err != nil {
			return "", err
		}
		if !enabled {
			return "", providerFailure("ASR_PROVIDER_NOT_CONFIGURED", "The local recognizer configuration is unavailable", false)
		}
		return transcribeLocalASR(ctx, local, bytes.NewReader(wavBytes), "audio/wav")
	}
	if c.Mode == "fixture" {
		fixtureText := os.Getenv("GROWDESK_ASR_FIXTURE_TEXT")
		if fixtureText == "" {
			return "", providerFailure("ASR_PROVIDER_NOT_CONFIGURED", "An explicit ASR fixture is required", false)
		}
		return validateASRTranscript(fixtureText)
	}

	// Real OpenAI-compatible transcription
	endpoint := strings.TrimSuffix(c.Endpoint, "/chat/completions") + "/audio/transcriptions"
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("file", "voice.wav")
	if err != nil {
		return "", err
	}
	if _, err := part.Write(wavBytes); err != nil {
		return "", err
	}
	if err := writer.WriteField("model", c.ASRModel); err != nil {
		return "", err
	}
	if err := writer.WriteField("response_format", "json"); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	client := providerHTTPClient(c.Timeout)
	defer client.CloseIdleConnections()

	result, err := providerReadJSON(ctx, client, req)
	if err != nil {
		return "", err
	}
	transcript, ok := result["text"].(string)
	if !ok {
		return "", providerFailure("ASR_PROVIDER_INVALID_RESPONSE", "Transcription is missing or too large", false)
	}
	return validateASRTranscript(transcript)
}

func buildWavFile(pcmData []byte, sampleRate uint32, channels uint16, bitsPerSample uint16) []byte {
	header := make([]byte, 44)
	pcmBytes := uint32(len(pcmData))
	riffSize := pcmBytes + 36

	copy(header[0:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], riffSize)
	copy(header[8:12], "WAVE")
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)
	binary.LittleEndian.PutUint16(header[20:22], 1)
	binary.LittleEndian.PutUint16(header[22:24], channels)
	binary.LittleEndian.PutUint32(header[24:28], sampleRate)
	byteRate := sampleRate * uint32(channels) * uint32(bitsPerSample/8)
	binary.LittleEndian.PutUint32(header[28:32], byteRate)
	blockAlign := channels * (bitsPerSample / 8)
	binary.LittleEndian.PutUint16(header[32:34], blockAlign)
	binary.LittleEndian.PutUint16(header[34:36], bitsPerSample)
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], pcmBytes)

	var buf bytes.Buffer
	buf.Write(header)
	buf.Write(pcmData)
	return buf.Bytes()
}
