package backend

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
)

func passportDeviceDTO(row Object) Object {
	result := Object{
		"id":              row["id"],
		"ownerUserId":     row["owner_user_id"],
		"familyId":        row["family_id"],
		"babyId":          row["baby_id"],
		"deviceLabel":     row["device_label"],
		"firmwareVersion": row["firmware_version"],
		"hardwareVersion": row["hardware_version"],
		"capabilities":    row["capabilities"],
		"lastSeenAt":      isoValue(row["last_seen_at"]),
		"revokedAt":       isoValue(row["revoked_at"]),
		"createdAt":       isoValue(row["created_at"]),
		"updatedAt":       isoValue(row["updated_at"]),
	}
	return result
}

func (s *Server) listPassportDevices(ctx context.Context, r *Request) (Result, error) {
	args := []any{r.Principal.UserID}
	where := "owner_user_id = $1"

	if raw := r.HTTP.URL.Query().Get("cursor"); raw != "" {
		clock, id, err := companionCursor(raw, "INVALID_PASSPORT_CURSOR")
		if err != nil {
			return Result{}, err
		}
		where += " AND (created_at, id) < ($2, $3)"
		args = append(args, clock, id)
	}

	limit := companionLimit(r, 20, 100)
	args = append(args, limit+1)

	rows, err := many(ctx, s.DB, "SELECT to_jsonb(d) FROM passport_devices d WHERE "+where+
		" ORDER BY created_at DESC, id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return Result{}, err
	}

	var next any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = encodeCareCursor(last["created_at"], last["id"])
	}

	data := make([]Object, 0, len(rows))
	for _, row := range rows {
		data = append(data, passportDeviceDTO(row))
	}

	return Result{Status: http.StatusOK, Body: page(data, next)}, nil
}

func (s *Server) getPassportDevice(ctx context.Context, r *Request) (Result, error) {
	deviceID := r.Params["id"]
	row, err := one(ctx, s.DB, `SELECT to_jsonb(d) FROM passport_devices d WHERE id = $1 AND owner_user_id = $2`,
		deviceID, r.Principal.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("PassportDevice", deviceID)
	}
	if err != nil {
		return Result{}, err
	}

	return ok(passportDeviceDTO(row))
}

func (s *Server) revokePassportDevice(ctx context.Context, r *Request) (Result, error) {
	deviceID := r.Params["id"]
	tag, err := s.DB.Exec(ctx, `UPDATE passport_devices
		SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
		WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
		deviceID, r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}

	if tag.RowsAffected() != 1 {
		// Either already revoked or not found
		var exists bool
		_ = s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM passport_devices WHERE id = $1 AND owner_user_id = $2)`,
			deviceID, r.Principal.UserID).Scan(&exists)
		if !exists {
			return Result{}, notFound("PassportDevice", deviceID)
		}
		// Already revoked is idempotent success
	}

	return ok(Object{"success": true})
}
