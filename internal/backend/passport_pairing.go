package backend

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerPassport() {
	s.Register("createPassportPairing", true, s.createPassportPairing)
	s.Register("claimPassportPairing", false, s.claimPassportPairing)
	s.Register("pollPassportPairing", true, s.pollPassportPairing)
	s.Register("exchangePassportAuthToken", true, s.exchangePassportAuthToken)
	s.Register("listPassportDevices", false, s.listPassportDevices)
	s.Register("getPassportDevice", false, s.getPassportDevice)
	s.Register("revokePassportDevice", false, s.revokePassportDevice)
	s.Register("connectPassportWebSocket", true, s.handlePassportWebSocket)
}

// generatePairCode generates an 8-character human-readable code in format "XXXX-XXXX",
// avoiding easily confused characters (0, O, 1, I).
func generatePairCode() (string, error) {
	const charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	code := make([]byte, 8)
	for i := 0; i < 8; i++ {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			return "", err
		}
		code[i] = charset[num.Int64()]
	}
	return fmt.Sprintf("%s-%s", string(code[:4]), string(code[4:])), nil
}

func normalizePairCode(raw string) string {
	cleaned := strings.ToUpper(strings.TrimSpace(raw))
	cleaned = strings.ReplaceAll(cleaned, "-", "")
	cleaned = strings.ReplaceAll(cleaned, " ", "")
	if len(cleaned) == 8 {
		return fmt.Sprintf("%s-%s", cleaned[:4], cleaned[4:])
	}
	return strings.ToUpper(strings.TrimSpace(raw))
}

func (s *Server) createPassportPairing(ctx context.Context, r *Request) (Result, error) {
	hardware := strings.TrimSpace(text(r.Body["hardware"]))
	firmwareVersion := strings.TrimSpace(text(r.Body["firmwareVersion"]))
	if hardware == "" || firmwareVersion == "" {
		return Result{}, apiError(http.StatusBadRequest, "INVALID_PAIRING_REQUEST", "hardware and firmwareVersion are required")
	}

	pairCode, err := generatePairCode()
	if err != nil {
		return Result{}, err
	}
	pairCodeHash := hashText(pairCode)
	pollToken := randomHex(32)
	pollTokenHash := hashText(pollToken)

	pairingID := newID()
	expiresAt := time.Now().UTC().Add(10 * time.Minute)

	deviceInfo := Object{
		"hardware":        hardware,
		"firmwareVersion": firmwareVersion,
		"capabilities":    r.Body["capabilities"],
	}
	deviceInfoJSON, err := jsonText(deviceInfo)
	if err != nil {
		return Result{}, err
	}

	_, err = s.DB.Exec(ctx, `INSERT INTO passport_pairings
		(id, pair_code_hash, poll_token_hash, device_info, expires_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4::jsonb, $5, clock_timestamp(), clock_timestamp())`,
		pairingID, pairCodeHash, pollTokenHash, deviceInfoJSON, expiresAt)
	if err != nil {
		return Result{}, err
	}

	return Result{
		Status: http.StatusCreated,
		Body: envelope(Object{
			"pairingId": pairingID,
			"pairCode":  pairCode,
			"pollToken": pollToken,
			"expiresAt": iso(expiresAt),
		}),
	}, nil
}

func (s *Server) claimPassportPairing(ctx context.Context, r *Request) (Result, error) {
	rawPairCode := text(r.Body["pairCode"])
	pairCode := normalizePairCode(rawPairCode)
	familyID := strings.TrimSpace(text(r.Body["familyId"]))
	babyID := strings.TrimSpace(text(r.Body["babyId"]))
	deviceLabel := strings.TrimSpace(text(r.Body["deviceLabel"]))
	if deviceLabel == "" {
		deviceLabel = "FoloToy AI Passport"
	}

	if pairCode == "" || familyID == "" || babyID == "" {
		return Result{}, apiError(http.StatusBadRequest, "INVALID_CLAIM_REQUEST", "pairCode, familyId, and babyId are required")
	}

	// Verify the authenticated user has access to family and baby
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, babyID, false)
	if err != nil {
		return Result{}, err
	}
	if scope.FamilyID != familyID {
		return Result{}, apiError(http.StatusForbidden, "FAMILY_ACCESS_DENIED", "Baby does not belong to specified family")
	}

	pairCodeHash := hashText(pairCode)

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)

	var pairingID string
	var expiresAt time.Time
	var claimedAt, completedAt *time.Time

	err = tx.QueryRow(ctx, `SELECT id, expires_at, claimed_at, completed_at
		FROM passport_pairings WHERE pair_code_hash = $1 FOR UPDATE`, pairCodeHash).Scan(&pairingID, &expiresAt, &claimedAt, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(http.StatusNotFound, "PAIRING_NOT_FOUND", "Pairing code not found or invalid")
	}
	if err != nil {
		return Result{}, err
	}

	if time.Now().UTC().After(expiresAt) {
		return Result{}, apiError(http.StatusGone, "PAIRING_EXPIRED", "Pairing code has expired")
	}

	if claimedAt != nil || completedAt != nil {
		return Result{}, apiError(http.StatusConflict, "PAIRING_ALREADY_CLAIMED", "Pairing code has already been claimed")
	}

	tag, err := tx.Exec(ctx, `UPDATE passport_pairings
		SET claimed_at = clock_timestamp(),
		    owner_user_id = $1,
		    family_id = $2,
		    baby_id = $3,
		    device_label = $4,
		    updated_at = clock_timestamp()
		WHERE id = $5 AND claimed_at IS NULL AND expires_at > clock_timestamp()`,
		r.Principal.UserID, familyID, babyID, deviceLabel, pairingID)
	if err != nil {
		return Result{}, err
	}
	if tag.RowsAffected() != 1 {
		return Result{}, apiError(http.StatusConflict, "PAIRING_ALREADY_CLAIMED", "Pairing code has already been claimed or expired")
	}

	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}

	return ok(Object{
		"pairingId": pairingID,
		"status":    "claimed",
	})
}

func (s *Server) pollPassportPairing(ctx context.Context, r *Request) (Result, error) {
	pairingID := r.Params["id"]
	pollToken := strings.TrimSpace(text(r.Body["pollToken"]))
	if pollToken == "" {
		return Result{}, apiError(http.StatusBadRequest, "INVALID_POLL_REQUEST", "pollToken is required")
	}

	pollTokenHash := hashText(pollToken)

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)

	var row struct {
		id             string
		pollTokenHash  string
		deviceInfo     Object
		deviceLabel    *string
		ownerUserID    *string
		familyID       *string
		babyID         *string
		credentialHash *string
		expiresAt      time.Time
		claimedAt      *time.Time
		completedAt    *time.Time
	}

	var rawDeviceInfo []byte
	err = tx.QueryRow(ctx, `SELECT id, poll_token_hash, device_info, device_label, owner_user_id, family_id, baby_id,
		credential_hash, expires_at, claimed_at, completed_at
		FROM passport_pairings WHERE id = $1 FOR UPDATE`, pairingID).Scan(
		&row.id, &row.pollTokenHash, &rawDeviceInfo, &row.deviceLabel, &row.ownerUserID,
		&row.familyID, &row.babyID, &row.credentialHash, &row.expiresAt, &row.claimedAt, &row.completedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("PassportPairing", pairingID)
	}
	if err != nil {
		return Result{}, err
	}

	// Constant-time check on pollToken
	if subtle.ConstantTimeCompare([]byte(row.pollTokenHash), []byte(pollTokenHash)) != 1 {
		return Result{}, apiError(http.StatusUnauthorized, "INVALID_POLL_TOKEN", "Poll token does not match pairing")
	}

	if time.Now().UTC().After(row.expiresAt) {
		return ok(Object{"status": "expired"})
	}

	if row.claimedAt == nil {
		return ok(Object{"status": "pending"})
	}

	// If already completed in a previous poll, do NOT return credential again (one-time return to device).
	if row.completedAt != nil {
		return ok(Object{
			"status":   "completed",
			"familyId": row.familyID,
			"babyId":   row.babyID,
		})
	}

	// First time completing: generate 32-byte random device credential
	if err := decodeJSON(rawDeviceInfo, &row.deviceInfo); err != nil {
		row.deviceInfo = Object{}
	}

	deviceCredential := randomHex(32)
	credentialHash := hashText(deviceCredential)
	deviceID := newID()

	deviceLabel := "FoloToy AI Passport"
	if row.deviceLabel != nil && *row.deviceLabel != "" {
		deviceLabel = *row.deviceLabel
	}

	hardware := text(row.deviceInfo["hardware"])
	firmwareVersion := text(row.deviceInfo["firmwareVersion"])
	var capabilities any = row.deviceInfo["capabilities"]
	capabilitiesJSON, _ := jsonText(capabilities)

	// Insert into passport_devices
	_, err = tx.Exec(ctx, `INSERT INTO passport_devices
		(id, owner_user_id, family_id, baby_id, device_label, credential_hash, firmware_version, hardware_version, capabilities, last_seen_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
		deviceID, *row.ownerUserID, *row.familyID, *row.babyID, deviceLabel,
		credentialHash, firmwareVersion, hardware, capabilitiesJSON)
	if err != nil {
		return Result{}, err
	}

	// Mark pairing completed and store credential_hash (never plaintext)
	_, err = tx.Exec(ctx, `UPDATE passport_pairings
		SET completed_at = clock_timestamp(), credential_hash = $1, updated_at = clock_timestamp()
		WHERE id = $2`, credentialHash, pairingID)
	if err != nil {
		return Result{}, err
	}

	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}

	return ok(Object{
		"status":           "completed",
		"deviceId":         deviceID,
		"deviceCredential": deviceCredential,
		"familyId":         *row.familyID,
		"babyId":           *row.babyID,
	})
}
