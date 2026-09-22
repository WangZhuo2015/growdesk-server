package backend

import (
	"context"
	"net/http"
	"strconv"
)

func (s *Server) registerNotifications() {
	s.registerDeclared(http.MethodPut, "/api/v1/devices/{installationId}/push", s.registerPushDevice)
	s.registerDeclared(http.MethodDelete, "/api/v1/devices/{installationId}/push", s.unregisterPushDevice)
	s.registerDeclared(http.MethodGet, "/api/v1/notifications", s.listNotifications)
	s.registerDeclared(http.MethodPost, "/api/v1/notifications/{id}/read", s.readNotification)
}

func (s *Server) registerPushDevice(ctx context.Context, r *Request) (Result, error) {
	_, err := s.DB.Exec(ctx, `INSERT INTO push_devices
		(id,user_id,installation_id,platform,environment,token,device_label,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp())
		ON CONFLICT(user_id,installation_id) DO UPDATE SET
		platform=EXCLUDED.platform,environment=EXCLUDED.environment,token=EXCLUDED.token,
		device_label=EXCLUDED.device_label,updated_at=EXCLUDED.updated_at`,
		newID(), r.Principal.UserID, r.Params["installationId"], text(r.Body["platform"]),
		text(r.Body["environment"]), text(r.Body["token"]), r.Body["deviceLabel"])
	if err != nil {
		return Result{}, err
	}
	return ok(Object{"success": true})
}

func (s *Server) unregisterPushDevice(ctx context.Context, r *Request) (Result, error) {
	_, err := s.DB.Exec(ctx, `DELETE FROM push_devices WHERE user_id=$1 AND installation_id=$2`,
		r.Principal.UserID, r.Params["installationId"])
	if err != nil {
		return Result{}, err
	}
	return ok(Object{"success": true})
}

func notificationDTO(row Object) Object {
	result := Object{
		"id": row["id"], "userId": row["user_id"], "eventKey": row["event_key"],
		"title": row["title"], "body": row["body"],
		"readAt": isoValue(row["read_at"]), "createdAt": isoValue(row["created_at"]),
	}
	// The reference omits data for SQL/JSON null; it does not emit data:null.
	if row["data"] != nil {
		result["data"] = row["data"]
	}
	return result
}

func (s *Server) listNotifications(ctx context.Context, r *Request) (Result, error) {
	args := []any{r.Principal.UserID}
	where := "user_id=$1"
	if raw := r.HTTP.URL.Query().Get("cursor"); raw != "" {
		clock, id, err := companionCursor(raw, "INVALID_NOTIFICATION_CURSOR")
		if err != nil {
			return Result{}, err
		}
		where += " AND (created_at,id)<($2,$3)"
		args = append(args, clock, id)
	}
	limit := companionLimit(r, 20, 100)
	args = append(args, limit+1)
	rows, err := many(ctx, s.DB, "SELECT to_jsonb(n) FROM notifications n WHERE "+where+
		" ORDER BY created_at DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
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
		data = append(data, notificationDTO(row))
	}
	return Result{Status: http.StatusOK, Body: page(data, next)}, nil
}

func (s *Server) readNotification(ctx context.Context, r *Request) (Result, error) {
	// Atomic authorization + readAt preservation: concurrent reads cannot replace
	// the first-read timestamp or modify another user's notification.
	tag, err := s.DB.Exec(ctx, `UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp())
		WHERE id=$1 AND user_id=$2`, r.Params["id"], r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}
	if tag.RowsAffected() != 1 {
		return Result{}, notFound("Notification", r.Params["id"])
	}
	return ok(Object{"success": true})
}
