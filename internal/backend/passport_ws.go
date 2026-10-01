package backend

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
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
	var writeMu sync.Mutex
	sendJSON := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(v)
	}
	sendBinary := func(data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(websocket.BinaryMessage, data)
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
		currentPending  *pendingCardProposal
		ttsCancel       context.CancelFunc
		ttsCancelMu     sync.Mutex
		seenTurns       = make(map[string]bool)
	)

	stopTTS := func() {
		ttsCancelMu.Lock()
		defer ttsCancelMu.Unlock()
		if ttsCancel != nil {
			ttsCancel()
			ttsCancel = nil
		}
	}

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
			// User pressed OK button to start talking
			stopTTS() // PTT immediately interrupts any playing TTS
			turnID := text(frame["turnId"])
			if turnID == "" {
				turnID = newID()
			}
			if seenTurns[turnID] {
				// Idempotency: ignore duplicate turnId
				continue
			}
			seenTurns[turnID] = true
			currentTurnID = turnID
			currentAudioBuf.Reset()
			isRecording = true

		case "audio.end":
			// User released OK button
			if !isRecording {
				continue
			}
			isRecording = false
			turnID := text(frame["turnId"])
			if turnID == "" {
				turnID = currentTurnID
			}

			pcmData := currentAudioBuf.Bytes()
			if len(pcmData) < 1600 { // less than ~50ms of audio
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "VOICE_TOO_SHORT", "message": "Voice input was too short"})
				continue
			}

			// Wrap PCM in temporary WAV format for ASR
			wavData := buildWavFile(pcmData, 16000, 1, 16)

			// Process ASR and Agent asynchronously to avoid blocking websocket read loop
			go func(tID string, wavBytes []byte) {
				s.processVoiceTurn(ctx, principal, sessionID, babyName, tID, wavBytes, sendJSON, sendBinary, &ttsCancel, &ttsCancelMu, &currentPending)
			}(turnID, wavData)

		case "card.confirm":
			runID := text(frame["runId"])
			planHash := text(frame["planHash"])
			actionID := text(frame["actionId"])

			if currentPending == nil || currentPending.RunID != runID {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "NO_PENDING_PROPOSAL", "message": "No active proposal card found"})
				continue
			}

			if actionID == "" {
				actionID = currentPending.Action.ActionID
			}

			recordID, err := s.executePassportCardConfirmation(ctx, principal, runID, planHash, actionID, currentPending.PlanHash, currentPending.Action, currentPending.ExpiresAt)
			if err != nil {
				_ = sendJSON(Object{"v": 1, "type": "error", "code": "CONFIRM_FAILED", "message": err.Error()})
			} else {
				currentPending = nil
				_ = sendJSON(Object{
					"v":          1,
					"type":       "card.saved",
					"runId":      runID,
					"entityType": currentPendingEntityType(currentPending),
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
	ttsCancelOut *context.CancelFunc,
	ttsCancelMu *sync.Mutex,
	pendingOut **pendingCardProposal,
) {
	config, err := nativeProviderConfiguration()
	if err != nil {
		_ = sendJSON(Object{"v": 1, "type": "error", "code": "PROVIDER_ERROR", "message": err.Error()})
		return
	}

	// 1. Transcribe Audio
	transcript, err := s.transcribePassportWav(ctx, config, wavBytes)
	if err != nil {
		_ = sendJSON(Object{"v": 1, "type": "error", "code": "ASR_FAILED", "message": "Voice recognition failed"})
		return
	}

	_ = sendJSON(Object{
		"v":      1,
		"type":   "asr.final",
		"turnId": turnID,
		"text":   transcript,
	})

	// 2. Append User Message
	if sessionID != "" {
		_, _ = s.DB.Exec(ctx, `INSERT INTO ai_messages(id, session_id, role, content, created_at) VALUES($1, $2, 'user', $3, NOW())`,
			newID(), sessionID, transcript)
	}

	// 3. Load bounded history (recent 12 messages, max 32KB)
	historyMessages := s.loadBoundedSessionHistory(ctx, sessionID, 12, 32*1024)

	// 4. Call Cloud Agent
	runID := newID()
	agentResult, err := s.callPassportAgent(ctx, config, sessionID, principal.BabyID, babyName, transcript, historyMessages)
	if err != nil {
		_ = sendJSON(Object{"v": 1, "type": "error", "code": "AGENT_FAILED", "message": "AI assistant processing failed"})
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
			_, _ = s.DB.Exec(ctx, `INSERT INTO ai_messages(id, session_id, role, content, created_at) VALUES($1, $2, 'assistant', $3, NOW())`,
				newID(), sessionID, agentResult.Text)
		}
	}

	// 6. Project Proposals to Cards
	if len(agentResult.Actions) > 0 {
		action := agentResult.Actions[0]
		card, err := projectActionToCard(action)
		if err == nil {
			var rawActions []any
			for _, a := range agentResult.Actions {
				rawActions = append(rawActions, Object{
					"actionId":   a.ActionID,
					"entityType": a.EntityType,
					"operation":  a.Operation,
					"summary":    a.Summary,
					"payload":    a.Payload,
				})
			}
			planHash, _ := canonicalNativeHash(rawActions)
			expiry := time.Now().Add(2 * time.Minute)

			*pendingOut = &pendingCardProposal{
				RunID:     runID,
				PlanHash:  planHash,
				Action:    action,
				ExpiresAt: expiry,
			}

			_ = sendJSON(Object{
				"v":     1,
				"type":  "card.present",
				"runId": runID,
				"card":  card,
				"confirmation": Object{
					"planHash":  planHash,
					"actionIds": []string{action.ActionID},
					"expiresAt": expiry.Format(time.RFC3339),
				},
			})
		}
	}

	// 7. TTS Streaming (Half-duplex)
	if agentResult.Text != "" {
		ttsCtx, cancel := context.WithCancel(ctx)
		ttsCancelMu.Lock()
		*ttsCancelOut = cancel
		ttsCancelMu.Unlock()

		defer func() {
			ttsCancelMu.Lock()
			*ttsCancelOut = nil
			ttsCancelMu.Unlock()
			cancel()
		}()

		s.streamTTS(ttsCtx, config, turnID, agentResult.Text, sendJSON, sendBinary)
	}
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

func (s *Server) callPassportAgent(ctx context.Context, c nativeProviderConfig, sessionID, babyID, babyName, userMessage string, history []Object) (nativeAIResult, error) {
	if c.Mode == "fixture" {
		if c.Fixture != "" {
			return parseNativeAssistant(c.Fixture)
		}
		// Default fixture proposal for tests
		actionID := newID()
		return nativeAIResult{
			Text: fmt.Sprintf("好的，已经为您准备好记录：%s 刚刚喝了 140 毫升配方奶。", babyName),
			Actions: []nativeAIAction{
				{
					ActionID:   actionID,
					EntityType: "feeding",
					Operation:  "create",
					Summary:    "记录喂奶 140 mL",
					Payload: Object{
						"type":       "formula",
						"amountMl":   "140",
						"occurredAt": time.Now().Format(time.RFC3339),
					},
				},
			},
		}, nil
	}

	// OpenAI-compatible call with structured tool/system prompt
	systemPrompt := fmt.Sprintf("You are GrowDesk's private AI assistant for baby '%s'. Return JSON with 'text' and 'actions'. " +
		"Supported entities: feeding, sleep, diaper, food, supplement, growth. Operation must be 'create'. " +
		"Actions are proposals only. Never claim database write has finished.", babyName)

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

	resp, err := client.Do(req)
	if err != nil {
		return nativeAIResult{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
	if err != nil {
		return nativeAIResult{}, err
	}

	var objResp Object
	if err := decodeJSON(body, &objResp); err != nil {
		return nativeAIResult{}, err
	}

	choices, _ := objResp["choices"].([]any)
	if len(choices) == 0 {
		return nativeAIResult{}, errors.New("no completion choices")
	}
	content := text(obj(obj(choices[0])["message"])["content"])
	return parseNativeAssistant(content)
}

func (s *Server) transcribePassportWav(ctx context.Context, c nativeProviderConfig, wavBytes []byte) (string, error) {
	if c.Mode == "fixture" {
		fixtureText := os.Getenv("GROWDESK_ASR_FIXTURE_TEXT")
		if fixtureText == "" {
			fixtureText = "刚喝了 140 毫升配方奶"
		}
		return fixtureText, nil
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
	_ = writer.WriteField("model", c.ASRModel)
	_ = writer.WriteField("response_format", "json")
	_ = writer.Close()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	client := providerHTTPClient(c.Timeout)
	defer client.CloseIdleConnections()

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result Object
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
	if err != nil {
		return "", err
	}
	if err := decodeJSON(raw, &result); err != nil {
		return "", err
	}
	transcript := text(result["text"])
	if transcript == "" {
		return "", errors.New("empty transcription")
	}
	return transcript, nil
}

func (s *Server) streamTTS(
	ctx context.Context,
	c nativeProviderConfig,
	turnID, textToSpeak string,
	sendJSON func(any) error,
	sendBinary func([]byte) error,
) {
	sampleRate := 24000
	_ = sendJSON(Object{
		"v":      1,
		"type":   "tts.start",
		"turnId": turnID,
		"audioFormat": Object{
			"codec":      "pcm_s16le",
			"sampleRate": sampleRate,
			"channels":   1,
		},
	})

	var pcmSource io.ReadCloser
	if c.Mode == "fixture" {
		// Generate small 100ms silence/test frames in fixture mode
		pcmData := make([]byte, sampleRate*2/10) // 100ms of 16-bit mono
		pcmSource = io.NopCloser(bytes.NewReader(pcmData))
	} else {
		endpoint := strings.TrimSuffix(c.Endpoint, "/chat/completions") + "/audio/speech"
		payload := Object{
			"model":           "tts-1",
			"input":           textToSpeak,
			"voice":           "alloy",
			"response_format": "pcm", // 24kHz 16-bit mono little-endian
		}
		raw, _ := jsonBytes(payload)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.APIKey)
			client := providerHTTPClient(c.Timeout)
			resp, err := client.Do(req)
			if err == nil && resp.StatusCode == 200 {
				pcmSource = resp.Body
			}
		}
	}

	if pcmSource != nil {
		defer pcmSource.Close()
		chunk := make([]byte, 1920) // ~40ms at 24kHz 16-bit mono
		for {
			select {
			case <-ctx.Done():
				return // Aborted by client interruption!
			default:
			}
			n, err := pcmSource.Read(chunk)
			if n > 0 {
				if err := sendBinary(chunk[:n]); err != nil {
					break
				}
				time.Sleep(35 * time.Millisecond) // Approximate real-time streaming pace
			}
			if err != nil {
				break
			}
		}
	}

	_ = sendJSON(Object{
		"v":      1,
		"type":   "tts.end",
		"turnId": turnID,
	})
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
