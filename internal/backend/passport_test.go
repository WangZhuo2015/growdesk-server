package backend

import (
	"crypto/subtle"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestPassportRouteRegistration(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{}}
	s.RegisterBusinessHandlers()

	expectedRoutes := []struct {
		op       string
		isPublic bool
	}{
		{"createPassportPairing", true},
		{"claimPassportPairing", false},
		{"pollPassportPairing", true},
		{"exchangePassportAuthToken", true},
		{"listPassportDevices", false},
		{"getPassportDevice", false},
		{"revokePassportDevice", false},
		{"connectPassportWebSocket", true},
	}

	for _, er := range expectedRoutes {
		if s.Handlers[er.op] == nil {
			t.Errorf("passport handler missing: %s", er.op)
		}
		if s.Public[er.op] != er.isPublic {
			t.Errorf("public auth policy mismatch for %s: got %v, want %v", er.op, s.Public[er.op], er.isPublic)
		}
	}
}

func TestPassportPairCodeFormatting(t *testing.T) {
	for i := 0; i < 20; i++ {
		code, err := generatePairCode()
		if err != nil {
			t.Fatalf("failed to generate pair code: %v", err)
		}
		parts := strings.Split(code, "-")
		if len(parts) != 2 || len(parts[0]) != 4 || len(parts[1]) != 4 {
			t.Fatalf("pair code format invalid: %s", code)
		}
		// Must not contain easily confused characters 0, O, 1, I
		for _, c := range []rune{'0', 'O', '1', 'I'} {
			if strings.ContainsRune(code, c) {
				t.Fatalf("pair code contains ambiguous character %c: %s", c, code)
			}
		}
	}

	// Test normalisation
	cases := []struct {
		input    string
		expected string
	}{
		{"7K4P-M2QF", "7K4P-M2QF"},
		{"7k4p-m2qf", "7K4P-M2QF"},
		{" 7k4pm2qf ", "7K4P-M2QF"},
		{"7K4P M2QF", "7K4P-M2QF"},
	}
	for _, tc := range cases {
		got := normalizePairCode(tc.input)
		if got != tc.expected {
			t.Errorf("normalizePairCode(%q) = %q; want %q", tc.input, got, tc.expected)
		}
	}
}

func TestPassportTokenVerification(t *testing.T) {
	secret := strings.Repeat("p", 40)
	now := time.Now().UTC()
	deviceID := "test_dev_01"
	ownerID := "test_user_01"
	familyID := "test_fam_01"
	babyID := "test_baby_01"

	// Sign valid passport token
	validClaims := jwt.MapClaims{
		"sub":      deviceID,
		"typ":      "passport+jwt",
		"iss":      "growdesk-passport",
		"aud":      "growdesk-voice-gateway",
		"deviceId": deviceID,
		"uid":      ownerID,
		"fid":      familyID,
		"bid":      babyID,
		"scopes": []string{
			"passport:connect",
			"passport:voice",
			"passport:agent",
			"passport:confirm",
		},
		"iat": now.Unix(),
		"exp": now.Add(900 * time.Second).Unix(),
		"jti": "jti_01",
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims)
	tokenStr, err := token.SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}

	// Parse and verify
	parsedClaims := jwt.MapClaims{}
	parsedToken, err := jwt.ParseWithClaims(tokenStr, parsedClaims, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithIssuer("growdesk-passport"), jwt.WithAudience("growdesk-voice-gateway"), jwt.WithExpirationRequired())
	if err != nil || !parsedToken.Valid {
		t.Fatalf("valid passport token failed verification: %v", err)
	}
	if parsedClaims["typ"] != "passport+jwt" {
		t.Fatalf("expected typ passport+jwt, got %v", parsedClaims["typ"])
	}
	if parsedClaims["deviceId"] != deviceID || parsedClaims["bid"] != babyID {
		t.Fatalf("claims mismatch")
	}

	// Test expired token rejection
	expiredClaims := jwt.MapClaims{
		"sub":      deviceID,
		"typ":      "passport+jwt",
		"iss":      "growdesk-passport",
		"aud":      "growdesk-voice-gateway",
		"deviceId": deviceID,
		"uid":      ownerID,
		"fid":      familyID,
		"bid":      babyID,
		"iat":      now.Add(-2000 * time.Second).Unix(),
		"exp":      now.Add(-1000 * time.Second).Unix(),
	}
	expiredTokenStr, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, expiredClaims).SignedString([]byte(secret))
	_, err = jwt.ParseWithClaims(expiredTokenStr, jwt.MapClaims{}, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithExpirationRequired())
	if err == nil {
		t.Fatal("expired passport token should be rejected")
	}

	// Test wrong audience rejection
	wrongAudClaims := jwt.MapClaims{
		"sub":      deviceID,
		"typ":      "passport+jwt",
		"iss":      "growdesk-passport",
		"aud":      "wrong-audience",
		"deviceId": deviceID,
		"iat":      now.Unix(),
		"exp":      now.Add(900 * time.Second).Unix(),
	}
	wrongAudTokenStr, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, wrongAudClaims).SignedString([]byte(secret))
	_, err = jwt.ParseWithClaims(wrongAudTokenStr, jwt.MapClaims{}, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithAudience("growdesk-voice-gateway"))
	if err == nil {
		t.Fatal("wrong audience passport token should be rejected")
	}
}

func TestPassportDeviceCredentialHashing(t *testing.T) {
	cred1 := randomHex(32)
	cred2 := randomHex(32)
	if cred1 == cred2 {
		t.Fatal("random credentials collided")
	}

	hash1 := hashText(cred1)
	hash2 := hashText(cred2)

	if hash1 == hash2 {
		t.Fatal("hashes collided")
	}

	// Constant-time compare verification
	if subtle.ConstantTimeCompare([]byte(hash1), []byte(hashText(cred1))) != 1 {
		t.Fatal("constant time compare failed on match")
	}
	if subtle.ConstantTimeCompare([]byte(hash1), []byte(hashText(cred2))) != 0 {
		t.Fatal("constant time compare failed on mismatch")
	}
}

func TestPassportDeviceDTO(t *testing.T) {
	row := Object{
		"id":               "dev-123",
		"owner_user_id":    "user-456",
		"family_id":        "fam-789",
		"baby_id":          "baby-012",
		"device_label":     "My Passport",
		"firmware_version": "1.0.0",
		"hardware_version": "folo-ai-passport",
		"capabilities":     Object{"display": "240x320"},
		"last_seen_at":     "2026-05-02T03:04:05.000Z",
		"revoked_at":       nil,
		"created_at":       "2026-05-01T03:04:05.000Z",
		"updated_at":       "2026-05-02T03:04:05.000Z",
	}

	dto := passportDeviceDTO(row)
	if dto["id"] != "dev-123" || dto["deviceLabel"] != "My Passport" {
		t.Fatalf("DTO mapping failed: %v", dto)
	}
	if dto["revokedAt"] != nil {
		t.Fatalf("expected nil revokedAt, got %v", dto["revokedAt"])
	}
	if dto["capabilities"] == nil {
		t.Fatal("expected capabilities present")
	}
}

func TestPassportCardProjection(t *testing.T) {
	// 1. Feeding action
	feedingAction := nativeAIAction{
		ActionID:   "action-feed-01",
		EntityType: "feeding",
		Operation:  "create",
		Summary:    "记录喂奶 140 mL",
		Payload: Object{
			"type":       "formula",
			"amountMl":   "140",
			"occurredAt": "2026-10-01T09:32:00Z",
		},
	}
	card, err := projectActionToCard(feedingAction)
	if err != nil {
		t.Fatalf("project feeding action failed: %v", err)
	}
	if card.EntityType != "feeding" || card.Title != "记录喂奶" {
		t.Fatalf("unexpected card metadata: %+v", card)
	}
	if len(card.Fields) < 3 {
		t.Fatalf("expected at least 3 fields, got %d", len(card.Fields))
	}
	if card.Fields[1].Label != "奶量" || card.Fields[1].Value != "140" || card.Fields[1].Unit != "mL" || !card.Fields[1].Emphasis {
		t.Fatalf("unexpected feeding amount field: %+v", card.Fields[1])
	}

	// 2. Diaper action
	diaperAction := nativeAIAction{
		ActionID:   "action-diaper-01",
		EntityType: "diaper",
		Operation:  "create",
		Summary:    "记录换尿布",
		Payload: Object{
			"type":       "wet",
			"occurredAt": "2026-10-01T10:00:00Z",
		},
	}
	card, err = projectActionToCard(diaperAction)
	if err != nil {
		t.Fatalf("project diaper action failed: %v", err)
	}
	if card.EntityType != "diaper" || card.Title != "记录换尿布" {
		t.Fatalf("unexpected diaper card: %+v", card)
	}

	// 3. Sleep action
	sleepAction := nativeAIAction{
		ActionID:   "action-sleep-01",
		EntityType: "sleep",
		Operation:  "create",
		Summary:    "记录睡眠",
		Payload: Object{
			"durationMinutes": "72",
			"occurredAt":       "2026-10-01T11:00:00Z",
		},
	}
	card, err = projectActionToCard(sleepAction)
	if err != nil {
		t.Fatalf("project sleep action failed: %v", err)
	}
	if card.EntityType != "sleep" || card.Title != "记录睡眠" {
		t.Fatalf("unexpected sleep card: %+v", card)
	}

	// 4. Growth action
	growthAction := nativeAIAction{
		ActionID:   "action-growth-01",
		EntityType: "growth",
		Operation:  "create",
		Summary:    "记录生长",
		Payload: Object{
			"heightCm":   "68.5",
			"weightKg":   "8.2",
			"occurredAt": "2026-10-01T12:00:00Z",
		},
	}
	card, err = projectActionToCard(growthAction)
	if err != nil {
		t.Fatalf("project growth action failed: %v", err)
	}
	if card.EntityType != "growth" || card.Title != "生长记录" {
		t.Fatalf("unexpected growth card: %+v", card)
	}
}

func TestPassportWavBuilder(t *testing.T) {
	pcmData := make([]byte, 3200) // 100ms at 16kHz 16-bit mono
	wav := buildWavFile(pcmData, 16000, 1, 16)

	if len(wav) != 44+3200 {
		t.Fatalf("expected wav size %d, got %d", 44+3200, len(wav))
	}
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || string(wav[12:16]) != "fmt " || string(wav[36:40]) != "data" {
		t.Fatalf("invalid WAV header magic")
	}
}

