package backend

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

const voiceScopeSQL = ` FROM agent_voice_logs v
	JOIN babies b ON b.id=v.baby_id AND b.family_id=v.family_id AND b.deleted_at IS NULL
	JOIN families f ON f.id=b.family_id AND f.deleted_at IS NULL
	JOIN baby_members bm ON bm.baby_id=b.id AND bm.family_id=b.family_id AND bm.user_id=v.user_id
		AND bm.status='active' AND bm.deleted_at IS NULL
	JOIN family_members fm ON fm.family_id=b.family_id AND fm.user_id=v.user_id
		AND fm.status='active' AND fm.deleted_at IS NULL
	WHERE v.user_id=$1`

const voiceProjectionSQL = `SELECT to_jsonb(v) || jsonb_build_object('baby',
	jsonb_build_object('id',b.id,'nickname',b.nickname,'gender',b.gender))`

func (s *Server) registerVoiceLogs() {
	s.registerDeclared(http.MethodPost, "/api/v1/voice/logs", s.createVoiceLog)
	s.registerDeclared(http.MethodGet, "/api/v1/voice/logs", s.listVoiceLogs)
	s.registerDeclared(http.MethodGet, "/api/v1/voice/logs/{id}", s.getVoiceLog)
	s.registerDeclared(http.MethodPatch, "/api/v1/voice/logs/{id}", s.acknowledgeVoiceLog)
}

func voiceLogDTO(row Object) Object {
	return Object{
		"id": row["id"], "userId": row["user_id"], "familyId": row["family_id"], "babyId": row["baby_id"],
		"prompt": row["prompt"], "reply": row["reply"], "isAsync": row["is_async"],
		"isFastPath": row["is_fast_path"], "acknowledged": row["acknowledged"],
		"createdAt": isoValue(row["created_at"]), "baby": row["baby"],
	}
}

func (s *Server) createVoiceLog(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	// Voice history is private user state, not a clinical record mutation.
	// As in the reference, an active viewer may save their own conversation.
	baby, err := one(ctx, tx, `SELECT to_jsonb(b) FROM babies b
		JOIN families f ON f.id=b.family_id AND f.deleted_at IS NULL
		JOIN family_members fm ON fm.family_id=b.family_id AND fm.user_id=$1
			AND fm.status='active' AND fm.deleted_at IS NULL
		JOIN baby_members bm ON bm.baby_id=b.id AND bm.family_id=b.family_id AND bm.user_id=$1
			AND bm.status='active' AND bm.deleted_at IS NULL
		WHERE b.id=$2 AND b.deleted_at IS NULL FOR SHARE OF b,f,fm,bm`, r.Principal.UserID, text(r.Body["babyId"]))
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(403, "NOT_A_MEMBER", "Access denied to baby: "+text(r.Body["babyId"])+" (NOT_A_MEMBER)")
	}
	if err != nil {
		return Result{}, err
	}
	row, err := insertObject(ctx, tx, "agent_voice_logs", Object{
		"id": newID(), "user_id": r.Principal.UserID, "family_id": baby["family_id"], "baby_id": baby["id"],
		"prompt": text(r.Body["prompt"]), "reply": text(r.Body["reply"]), "is_async": boolean(r.Body["isAsync"]),
		"is_fast_path": boolean(r.Body["isFastPath"]), "acknowledged": boolean(r.Body["acknowledged"]),
	})
	if err != nil {
		return Result{}, err
	}
	row["baby"] = Object{"id": baby["id"], "nickname": baby["nickname"], "gender": baby["gender"]}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return created(voiceLogDTO(row))
}

func (s *Server) listVoiceLogs(ctx context.Context, r *Request) (Result, error) {
	query := voiceProjectionSQL + voiceScopeSQL
	args := []any{r.Principal.UserID}
	unread := r.HTTP.URL.Query().Get("unreadAsync") == "true"
	if unread {
		query += " AND v.is_async AND NOT v.acknowledged AND v.created_at >= $2 ORDER BY v.created_at DESC,v.id DESC LIMIT 1"
		args = append(args, time.Now().UTC().Add(-24*time.Hour))
	} else {
		query += " ORDER BY v.created_at DESC,v.id DESC LIMIT $2"
		args = append(args, companionLimit(r, 20, 50))
	}
	rows, err := many(ctx, s.DB, query, args...)
	if err != nil {
		return Result{}, err
	}
	if unread {
		if len(rows) == 0 {
			return ok(nil)
		}
		return ok(voiceLogDTO(rows[0]))
	}
	data := make([]Object, 0, len(rows))
	for _, row := range rows {
		data = append(data, voiceLogDTO(row))
	}
	return Result{Status: http.StatusOK, Body: page(data, nil)}, nil
}

func (s *Server) getVoiceLog(ctx context.Context, r *Request) (Result, error) {
	row, err := one(ctx, s.DB, voiceProjectionSQL+voiceScopeSQL+" AND v.id=$2", r.Principal.UserID, r.Params["id"])
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("AgentVoiceLog", r.Params["id"])
	}
	if err != nil {
		return Result{}, err
	}
	return ok(voiceLogDTO(row))
}

func (s *Server) acknowledgeVoiceLog(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	_, err = one(ctx, tx, voiceProjectionSQL+voiceScopeSQL+
		" AND v.id=$2 FOR UPDATE OF v FOR SHARE OF b,f,fm,bm", r.Principal.UserID, r.Params["id"])
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("AgentVoiceLog", r.Params["id"])
	}
	if err != nil {
		return Result{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE agent_voice_logs SET acknowledged=$3 WHERE id=$1 AND user_id=$2`,
		r.Params["id"], r.Principal.UserID, boolean(r.Body["acknowledged"]))
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"success": true})
}
