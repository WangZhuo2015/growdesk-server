package backend

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
)

type PassportPrincipal struct {
	DeviceID    string
	OwnerUserID string
	FamilyID    string
	BabyID      string
	DeviceLabel string
	Scopes      []string
}

func (s *Server) exchangePassportAuthToken(ctx context.Context, r *Request) (Result, error) {
	var deviceID, deviceCredential string

	// 1. Try Authorization header: Device <deviceId>.<deviceCredential>
	authHeader := r.HTTP.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Device ") {
		tokenPart := strings.TrimSpace(strings.TrimPrefix(authHeader, "Device "))
		parts := strings.SplitN(tokenPart, ".", 2)
		if len(parts) == 2 {
			deviceID = strings.TrimSpace(parts[0])
			deviceCredential = strings.TrimSpace(parts[1])
		}
	}

	// 2. Fallback to body
	if deviceID == "" || deviceCredential == "" {
		if r.Body != nil {
			deviceID = strings.TrimSpace(text(r.Body["deviceId"]))
			deviceCredential = strings.TrimSpace(text(r.Body["deviceCredential"]))
		}
	}

	if deviceID == "" || deviceCredential == "" {
		return Result{}, apiError(http.StatusUnauthorized, "DEVICE_CREDENTIAL_REQUIRED", "Device ID and credential are required")
	}

	// Fetch device record
	var row struct {
		id             string
		ownerUserID    string
		familyID       string
		babyID         string
		deviceLabel    string
		credentialHash string
		revokedAt      *time.Time
	}

	err := s.DB.QueryRow(ctx, `SELECT id, owner_user_id, family_id, baby_id, device_label, credential_hash, revoked_at
		FROM passport_devices WHERE id = $1`, deviceID).Scan(
		&row.id, &row.ownerUserID, &row.familyID, &row.babyID, &row.deviceLabel, &row.credentialHash, &row.revokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(http.StatusUnauthorized, "DEVICE_NOT_FOUND", "Device not registered or invalid")
	}
	if err != nil {
		return Result{}, err
	}

	if row.revokedAt != nil {
		return Result{}, apiError(http.StatusUnauthorized, "DEVICE_REVOKED", "Device has been revoked")
	}

	// Constant-time compare of credential hash
	givenHash := hashText(deviceCredential)
	if subtle.ConstantTimeCompare([]byte(row.credentialHash), []byte(givenHash)) != 1 {
		return Result{}, apiError(http.StatusUnauthorized, "INVALID_DEVICE_CREDENTIAL", "Device credential is invalid")
	}

	// Re-verify baby membership
	_, err = babyScope(ctx, s.DB, row.ownerUserID, row.babyID, false)
	if err != nil {
		return Result{}, apiError(http.StatusForbidden, "BABY_ACCESS_DENIED", "Baby membership revoked or invalid")
	}

	// Update last_seen_at
	_, _ = s.DB.Exec(ctx, `UPDATE passport_devices SET last_seen_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`, deviceID)

	// Issue 15-minute JWT
	now := time.Now().UTC()
	expiresIn := 900 // 15 minutes
	expiresAt := now.Add(time.Duration(expiresIn) * time.Second)

	claims := jwt.MapClaims{
		"sub":      deviceID,
		"typ":      "passport+jwt",
		"iss":      "growdesk-passport",
		"aud":      "growdesk-voice-gateway",
		"deviceId": deviceID,
		"uid":      row.ownerUserID,
		"fid":      row.familyID,
		"bid":      row.babyID,
		"scopes": []string{
			"passport:connect",
			"passport:voice",
			"passport:agent",
			"passport:confirm",
		},
		"iat": now.Unix(),
		"exp": expiresAt.Unix(),
		"jti": newID(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedToken, err := token.SignedString([]byte(s.Config.JWTSecret))
	if err != nil {
		return Result{}, err
	}

	return ok(Object{
		"accessToken": signedToken,
		"expiresIn":   expiresIn,
		"tokenType":   "Bearer",
	})
}

// AuthenticatePassport verifies a Passport access token and loads current DB authorization.
// CRITICAL: Baby scope is ALWAYS loaded from passport_devices.baby_id, NEVER trusted from client.
func (s *Server) AuthenticatePassport(ctx context.Context, tokenString string) (*PassportPrincipal, error) {
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, errors.New("invalid signing method")
		}
		return []byte(s.Config.JWTSecret), nil
	}, jwt.WithIssuer("growdesk-passport"), jwt.WithAudience("growdesk-voice-gateway"), jwt.WithExpirationRequired())

	if err != nil || !token.Valid || text(claims["typ"]) != "passport+jwt" {
		return nil, apiError(http.StatusUnauthorized, "INVALID_PASSPORT_TOKEN", "Passport token is invalid or expired")
	}

	deviceID := text(claims["deviceId"])
	if deviceID == "" {
		deviceID = text(claims["sub"])
	}
	if deviceID == "" {
		return nil, apiError(http.StatusUnauthorized, "INVALID_PASSPORT_TOKEN", "Device identifier missing in token")
	}

	// Always load from database to check revocation and get canonical scope
	var row struct {
		id          string
		ownerUserID string
		familyID    string
		babyID      string
		deviceLabel string
		revokedAt   *time.Time
	}

	err = s.DB.QueryRow(ctx, `SELECT id, owner_user_id, family_id, baby_id, device_label, revoked_at
		FROM passport_devices WHERE id = $1`, deviceID).Scan(
		&row.id, &row.ownerUserID, &row.familyID, &row.babyID, &row.deviceLabel, &row.revokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiError(http.StatusUnauthorized, "DEVICE_NOT_FOUND", "Device not registered")
	}
	if err != nil {
		return nil, err
	}

	if row.revokedAt != nil {
		return nil, apiError(http.StatusUnauthorized, "DEVICE_REVOKED", "Device access has been revoked")
	}

	// Re-verify baby scope in family
	_, err = babyScope(ctx, s.DB, row.ownerUserID, row.babyID, false)
	if err != nil {
		return nil, apiError(http.StatusForbidden, "BABY_ACCESS_DENIED", "Access to baby is no longer permitted")
	}

	var scopes []string
	if rawScopes, ok := claims["scopes"].([]any); ok {
		for _, sc := range rawScopes {
			if sText, ok := sc.(string); ok {
				scopes = append(scopes, sText)
			}
		}
	}

	return &PassportPrincipal{
		DeviceID:    row.id,
		OwnerUserID: row.ownerUserID,
		FamilyID:    row.familyID,
		BabyID:      row.babyID,
		DeviceLabel: row.deviceLabel,
		Scopes:      scopes,
	}, nil
}
