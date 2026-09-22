package backend

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const webAIVisibleBaby = `(s.baby_id IS NULL OR EXISTS (
	SELECT 1 FROM baby_members bm
	JOIN babies b ON b.id=bm.baby_id AND b.family_id=bm.family_id
	JOIN families f ON f.id=b.family_id AND f.deleted_at IS NULL
	JOIN family_members fm ON fm.family_id=b.family_id AND fm.user_id=bm.user_id
	WHERE bm.user_id=s.user_id AND bm.baby_id=s.baby_id
	AND bm.status='active' AND bm.deleted_at IS NULL
	AND fm.status='active' AND fm.deleted_at IS NULL AND b.deleted_at IS NULL))`

const webAIHistorySize = `SELECT count(*), COALESCE(sum(octet_length(content)
	+COALESCE(octet_length(image),0)+COALESCE(octet_length(tools_json),0)),0)::bigint
	FROM ai_messages WHERE session_id=$1`

var webAIProtectedImage = regexp.MustCompile(`(?i)^/api/attachments/([a-f0-9-]{36})$`)

func (s *Server) registerWebAISessions() {
	s.Register("createWebAiSession", false, s.createWebAISession)
	s.Register("listWebAiSessions", false, s.listWebAISessions)
	s.Register("getWebAiSession", false, s.getWebAISession)
	s.Register("renameWebAiSession", false, s.renameWebAISession)
	s.Register("deleteWebAiSession", false, s.deleteWebAISession)
	s.Register("appendWebAiMessage", false, s.appendWebAIMessage)
}

func webAIMessageDTO(row Object) Object {
	return Object{"id": row["id"], "sessionId": row["session_id"], "role": row["role"],
		"content": row["content"], "image": row["image"], "toolsJson": row["tools_json"],
		"createdAt": isoValue(row["created_at"])}
}

func webAISessionDTO(row Object, messages []Object, count int64, last any) Object {
	if messages == nil {
		messages = make([]Object, 0)
	}
	return Object{"id": row["id"], "userId": row["user_id"], "babyId": row["baby_id"],
		"title": row["title"], "contextType": row["context_type"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"]),
		"messages": messages, "messageCount": count, "lastMessage": last}
}

func webAITitle(value any) string {
	title := strings.TrimSpace(text(value))
	if title == "" {
		return "新对话"
	}
	return title
}

func webAITooLarge() error {
	return apiError(413, "CONVERSATION_TOO_LARGE", "Conversation history limit reached; existing history is preserved")
}

func (s *Server) withWebAISession(ctx context.Context, r *Request, work func(pgx.Tx, Object) (Result, error)) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	row, err := one(ctx, tx, `SELECT to_jsonb(s) FROM ai_sessions s WHERE s.id=$1 AND s.user_id=$2 AND `+
		webAIVisibleBaby+` FOR UPDATE OF s`, r.Params["id"], r.Principal.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "SESSION_NOT_FOUND", "Conversation not found or no longer authorized")
	}
	if err != nil {
		return Result{}, err
	}
	result, err := work(tx, row)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}

func (s *Server) createWebAISession(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if babyID := text(r.Body["babyId"]); babyID != "" {
		var id string
		err = tx.QueryRow(ctx, `SELECT b.id FROM babies b
			JOIN families f ON f.id=b.family_id AND f.deleted_at IS NULL
			JOIN baby_members bm ON bm.baby_id=b.id AND bm.family_id=b.family_id AND bm.user_id=$1
			JOIN family_members fm ON fm.family_id=b.family_id AND fm.user_id=$1
			WHERE b.id=$2 AND b.deleted_at IS NULL AND bm.status='active' AND bm.deleted_at IS NULL
			AND fm.status='active' AND fm.deleted_at IS NULL FOR SHARE OF b,f,bm,fm`,
			r.Principal.UserID, babyID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, apiError(403, "BABY_ACCESS_DENIED", "Baby access denied")
		}
		if err != nil {
			return Result{}, err
		}
	}
	contextType := strings.TrimSpace(text(r.Body["contextType"]))
	if contextType == "" {
		contextType = "general"
	}
	row, err := insertObject(ctx, tx, "ai_sessions", Object{
		"id": newID(), "user_id": r.Principal.UserID, "baby_id": r.Body["babyId"],
		"title": webAITitle(r.Body["title"]), "context_type": contextType,
	})
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return created(webAISessionDTO(row, nil, 0, nil))
}

func (s *Server) getWebAISession(ctx context.Context, r *Request) (Result, error) {
	return s.withWebAISession(ctx, r, func(tx pgx.Tx, session Object) (Result, error) {
		var count, size int64
		if err := tx.QueryRow(ctx, webAIHistorySize, session["id"]).Scan(&count, &size); err != nil {
			return Result{}, err
		}
		if count > 5000 || size > 16000000 {
			return Result{}, webAITooLarge()
		}
		rows, err := many(ctx, tx, `SELECT to_jsonb(m) FROM ai_messages m WHERE session_id=$1 ORDER BY created_at,id`, session["id"])
		if err != nil {
			return Result{}, err
		}
		messages := make([]Object, 0, len(rows))
		var last any
		for _, row := range rows {
			message := webAIMessageDTO(row)
			messages = append(messages, message)
			last = message
		}
		return ok(webAISessionDTO(session, messages, count, last))
	})
}

func optionalQuery(r *Request, name string) any {
	if values, exists := r.HTTP.URL.Query()[name]; exists && len(values) > 0 {
		return values[0]
	}
	return nil
}

func (s *Server) listWebAISessions(ctx context.Context, r *Request) (Result, error) {
	args := []any{r.Principal.UserID, optionalQuery(r, "babyId"), optionalQuery(r, "contextType")}
	where := `s.user_id=$1 AND ($2::text IS NULL OR s.baby_id=$2) AND ($3::text IS NULL OR s.context_type=$3) AND ` + webAIVisibleBaby
	var total int64
	if err := s.DB.QueryRow(ctx, "SELECT count(*) FROM ai_sessions s WHERE "+where, args...).Scan(&total); err != nil {
		return Result{}, err
	}
	offset, _ := strconv.Atoi(r.HTTP.URL.Query().Get("offset"))
	args = append(args, companionLimit(r, 30, 100), offset)
	rows, err := many(ctx, s.DB, "SELECT to_jsonb(s) FROM ai_sessions s WHERE "+where+
		" ORDER BY s.updated_at DESC,s.id DESC LIMIT $4 OFFSET $5", args...)
	if err != nil {
		return Result{}, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, text(row["id"]))
	}
	summaries := make(map[string]Object, len(rows))
	if len(ids) > 0 {
		// Same bounded batch query as the reference: no N+1 queries, image or
		// tool payloads, or data for a session outside the authorized page.
		values, err := many(ctx, s.DB, `SELECT jsonb_build_object(
			'session_id',requested.id,'message_count',(SELECT count(*) FROM ai_messages m WHERE m.session_id=requested.id),
			'last',CASE WHEN last_message.id IS NULL THEN NULL ELSE to_jsonb(last_message) END)
			FROM unnest($1::text[]) requested(id)
			LEFT JOIN LATERAL (SELECT m.id,m.session_id,m.role,left(m.content,4096) AS content,m.created_at
			FROM ai_messages m WHERE m.session_id=requested.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_message ON TRUE`, ids)
		if err != nil {
			return Result{}, err
		}
		for _, value := range values {
			summaries[text(value["session_id"])] = value
		}
	}
	data := make([]Object, 0, len(rows))
	for _, row := range rows {
		summary := summaries[text(row["id"])]
		if summary == nil {
			return Result{}, apiError(500, "INTERNAL_ERROR", "Incomplete conversation summaries")
		}
		var last any
		if message := obj(summary["last"]); message != nil {
			last = webAIMessageDTO(message)
		}
		data = append(data, webAISessionDTO(row, nil, integer(summary["message_count"]), last))
	}
	return ok(Object{"total": total, "sessions": data})
}

func (s *Server) renameWebAISession(ctx context.Context, r *Request) (Result, error) {
	return s.withWebAISession(ctx, r, func(tx pgx.Tx, session Object) (Result, error) {
		row, err := one(ctx, tx, `UPDATE ai_sessions s SET title=$3,updated_at=CURRENT_TIMESTAMP
			WHERE id=$1 AND user_id=$2 RETURNING to_jsonb(s)`, session["id"], r.Principal.UserID, webAITitle(r.Body["title"]))
		if err != nil {
			return Result{}, err
		}
		// Rename's response is a metadata projection, not a history read.
		return ok(webAISessionDTO(row, nil, 0, nil))
	})
}

func (s *Server) deleteWebAISession(ctx context.Context, r *Request) (Result, error) {
	return s.withWebAISession(ctx, r, func(tx pgx.Tx, session Object) (Result, error) {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_runs r JOIN task_executions t ON t.id=r.id
			WHERE r.session_id=$1 AND t.status NOT IN ('succeeded','failed','cancelled'))`, session["id"]).Scan(&active); err != nil {
			return Result{}, err
		}
		if active {
			return Result{}, apiError(409, "SESSION_RUN_ACTIVE", "Cancel the running task before deleting its conversation")
		}
		if _, err := tx.Exec(ctx, `DELETE FROM ai_sessions WHERE id=$1 AND user_id=$2`, session["id"], r.Principal.UserID); err != nil {
			return Result{}, err
		}
		return ok(Object{"deleted": true})
	})
}

func webAIReplay(row Object, sessionID string, body Object) (Result, error) {
	if text(row["session_id"]) != sessionID || text(row["role"]) != text(body["role"]) ||
		text(row["content"]) != text(body["content"]) || row["image"] != body["image"] || row["tools_json"] != body["toolsJson"] {
		return Result{}, apiError(409, "MESSAGE_ID_REUSED", "Message ID already has different content")
	}
	return created(webAIMessageDTO(row))
}

func (s *Server) appendWebAIMessage(ctx context.Context, r *Request) (Result, error) {
	return s.withWebAISession(ctx, r, func(tx pgx.Tx, session Object) (Result, error) {
		id, sessionID := text(r.Body["id"]), text(session["id"])
		existing, err := one(ctx, tx, `SELECT to_jsonb(m) FROM ai_messages m WHERE id=$1`, id)
		if err == nil {
			return webAIReplay(existing, sessionID, r.Body)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return Result{}, err
		}
		var count, size int64
		if err = tx.QueryRow(ctx, webAIHistorySize, sessionID).Scan(&count, &size); err != nil {
			return Result{}, err
		}
		added := int64(len(text(r.Body["content"])) + len(text(r.Body["image"])) + len(text(r.Body["toolsJson"])))
		if count >= 5000 || size+added > 16000000 {
			return Result{}, webAITooLarge()
		}
		if match := webAIProtectedImage.FindStringSubmatch(text(r.Body["image"])); match != nil {
			var attachmentID string
			err = tx.QueryRow(ctx, `SELECT a.id FROM attachments a
				JOIN family_members fm ON fm.family_id=a.family_id AND fm.user_id=$2
				LEFT JOIN baby_members bm ON bm.family_id=a.family_id AND bm.baby_id=a.baby_id AND bm.user_id=$2
				WHERE a.id=$1 AND a.purpose='ai_input' AND a.status='ready' AND a.deleted_at IS NULL
				AND fm.status='active' AND fm.deleted_at IS NULL
				AND (a.baby_id IS NULL OR (bm.status='active' AND bm.deleted_at IS NULL))
				AND a.baby_id IS NOT DISTINCT FROM $3::text FOR SHARE OF a`, match[1], r.Principal.UserID, session["baby_id"]).Scan(&attachmentID)
			if errors.Is(err, pgx.ErrNoRows) {
				return Result{}, apiError(409, "AI_IMAGE_ATTACHMENT_INVALID", "AI image attachment is unavailable or outside the conversation scope")
			}
			if err != nil {
				return Result{}, err
			}
		}
		row, err := one(ctx, tx, `INSERT INTO ai_messages AS m(id,session_id,role,content,image,tools_json,created_at)
			VALUES($1,$2,$3,$4,$5,$6,GREATEST(clock_timestamp(),COALESCE(
			(SELECT max(created_at)+interval '1 millisecond' FROM ai_messages WHERE session_id=$2),clock_timestamp())))
			ON CONFLICT(id) DO NOTHING RETURNING to_jsonb(m)`, id, sessionID, text(r.Body["role"]),
			text(r.Body["content"]), r.Body["image"], r.Body["toolsJson"])
		if errors.Is(err, pgx.ErrNoRows) {
			// Parent locks serialize one conversation. ON CONFLICT also handles
			// concurrent reuse of the global message ID across different parents.
			row, err = one(ctx, tx, `SELECT to_jsonb(m) FROM ai_messages m WHERE id=$1`, id)
			if err != nil {
				return Result{}, err
			}
			return webAIReplay(row, sessionID, r.Body)
		}
		if err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_sessions SET updated_at=clock_timestamp() WHERE id=$1`, sessionID); err != nil {
			return Result{}, err
		}
		return Result{Status: http.StatusCreated, Body: envelope(webAIMessageDTO(row))}, nil
	})
}
