package backend

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const personalAccessTokenLimit = 10

func (s *Server) registerPersonalAccessTokens() {
	s.Register("listPersonalAccessTokens", false, s.listPersonalAccessTokens)
	s.Register("createPersonalAccessToken", false, s.createPersonalAccessToken)
	s.Register("revokePersonalAccessToken", false, s.revokePersonalAccessToken)
	s.Register("listPersonalConnections", false, s.listPersonalConnections)
	s.Register("revokePersonalConnection", false, s.revokePersonalConnection)
	s.Register("getPersonalAIUsage", false, s.getPersonalAIUsage)
	s.Register("createPersonalVoiceTextRun", false, s.createPersonalVoiceTextRun)
	s.Register("getPersonalVoiceTextRun", false, s.getPersonalVoiceTextRun)
}

func personalAccessTokenDTO(row Object) Object {
	return Object{
		"id": row["id"], "name": row["name"], "tokenHint": row["token_hint"], "scopes": row["scopes"],
		"createdAt": isoValue(row["created_at"]), "lastUsedAt": isoValue(row["last_used_at"]),
		"expiresAt": isoValue(row["expires_at"]),
	}
}

func (s *Server) listPersonalAccessTokens(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "session" {
		return Result{}, apiError(401, "UNAUTHORIZED", "Invalid or expired access token")
	}
	rows, err := many(ctx, s.DB, `SELECT to_jsonb(p) FROM personal_access_tokens p
		WHERE p.user_id=$1 AND p.revoked_at IS NULL
		ORDER BY (p.expires_at IS NULL OR p.expires_at>NOW()) DESC,p.created_at DESC,p.id DESC LIMIT $2`,
		r.Principal.UserID, personalAccessTokenLimit)
	if err != nil {
		return Result{}, err
	}
	items := make([]Object, 0, len(rows))
	for _, row := range rows {
		items = append(items, personalAccessTokenDTO(row))
	}
	return ok(items)
}

func (s *Server) createPersonalAccessToken(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "session" {
		return Result{}, apiError(401, "UNAUTHORIZED", "Invalid or expired access token")
	}
	for key := range r.Body {
		if key != "name" && key != "expiresAt" {
			return Result{}, invalid("Unsupported personal token creation field")
		}
	}
	name := strings.TrimSpace(text(r.Body["name"]))
	if name == "" || len([]rune(name)) > 100 {
		return Result{}, invalid("Token name must contain 1 to 100 characters")
	}
	var expiresAt any
	if raw, ok := r.Body["expiresAt"]; ok && raw != nil {
		expires, err := asTime(raw)
		if err != nil || !expires.After(time.Now()) {
			return Result{}, invalid("Token expiration must be a future RFC3339 timestamp")
		}
		expiresAt = expires.UTC()
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, r.Principal.UserID); err != nil {
		return Result{}, err
	}
	var activeCount int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens
		WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())`, r.Principal.UserID).Scan(&activeCount); err != nil {
		return Result{}, err
	}
	if activeCount >= personalAccessTokenLimit {
		return Result{}, apiError(409, "PERSONAL_TOKEN_LIMIT", "Revoke or expire an existing token before creating another")
	}
	raw := personalAccessTokenPrefix + randomHex(32)
	hint := personalAccessTokenPrefix + "…" + raw[len(raw)-8:]
	row, err := one(ctx, tx, `INSERT INTO personal_access_tokens(id,user_id,name,token_hash,token_hint,scopes,expires_at)
		VALUES($1,$2,$3,$4,$5,ARRAY['voice:submit']::TEXT[],$6) RETURNING to_jsonb(personal_access_tokens)`,
		newID(), r.Principal.UserID, name, hashText(raw), hint, expiresAt)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	data := personalAccessTokenDTO(row)
	data["token"] = raw
	return Result{Status: http.StatusCreated, Body: envelope(data)}, nil
}

func (s *Server) revokePersonalAccessToken(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "session" {
		return Result{}, apiError(401, "UNAUTHORIZED", "Invalid or expired access token")
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, r.Principal.UserID); err != nil {
		return Result{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE personal_access_tokens SET revoked_at=NOW()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, r.Params["id"], r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}
	if tag.RowsAffected() == 0 {
		var owned bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM personal_access_tokens WHERE id=$1 AND user_id=$2)`,
			r.Params["id"], r.Principal.UserID).Scan(&owned); err != nil {
			return Result{}, err
		}
		if !owned {
			return Result{}, notFound("PersonalAccessToken", r.Params["id"])
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusOK, Body: success()}, nil
}

// validatePersonalAccessToken closes the gap between HTTP
// authentication and durable task creation. The user lock orders this check
// with token revocation; FOR SHARE keeps the credential row valid until commit.
func validatePersonalAccessToken(ctx context.Context, q Querier, principal Principal, requiredScope string, lockRow bool) error {
	if principal.AuthKind != "personal_access_token" || principal.PersonalAccessTokenID == "" {
		return apiError(401, "PERSONAL_TOKEN_INVALID", "Personal access token is invalid or expired")
	}
	var scopes []string
	var live bool
	query := `SELECT p.scopes,p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>NOW())
		FROM personal_access_tokens p JOIN users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.id=$1 AND p.user_id=$2`
	if lockRow {
		query += ` FOR SHARE OF p`
	}
	err := q.QueryRow(ctx, query,
		principal.PersonalAccessTokenID, principal.UserID).Scan(&scopes, &live)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !live) {
		return apiError(401, "PERSONAL_TOKEN_INVALID", "Personal access token is invalid or expired")
	}
	if err != nil {
		return err
	}
	if !containsScope(scopes, requiredScope) {
		return apiError(403, "PERSONAL_TOKEN_SCOPE_REQUIRED", "Personal access token does not grant this operation")
	}
	return nil
}

func (s *Server) listPersonalConnections(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "session" {
		return Result{}, apiError(401, "UNAUTHORIZED", "A verified app session is required")
	}
	rows, err := many(ctx, s.DB, `SELECT jsonb_build_object(
		'id',g.id,'client_id',g.client_id,'client_name',COALESCE(c.client_name,'Legacy OAuth client'),'resource',g.audience,'scopes',g.scopes,
		'family_id',g.family_id,'baby_id',g.baby_id,'created_at',g.created_at,'last_used_at',g.last_used_at,'revoked_at',g.revoked_at)
		FROM native_go.oauth_grants g LEFT JOIN native_go.oauth_clients c ON c.client_id=g.client_id
		WHERE g.user_id=$1 ORDER BY g.created_at DESC,g.id DESC LIMIT 100`, r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}
	items := make([]Object, 0, len(rows))
	for _, row := range rows {
		items = append(items, Object{"id": row["id"], "clientId": row["client_id"], "clientName": row["client_name"], "resource": row["resource"], "scopes": row["scopes"], "familyId": row["family_id"], "babyId": row["baby_id"], "createdAt": isoValue(row["created_at"]), "lastUsedAt": isoValue(row["last_used_at"]), "revokedAt": isoValue(row["revoked_at"])})
	}
	return Result{Status: http.StatusOK, Body: Object{"data": items, "managementAvailable": true}}, nil
}

func (s *Server) revokePersonalConnection(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "session" {
		return Result{}, apiError(401, "UNAUTHORIZED", "A verified app session is required")
	}
	id := r.Params["id"]
	pre, err := one(ctx, s.DB, `SELECT jsonb_build_object('family_id',family_id,'session_id',session_id) FROM native_go.oauth_grants WHERE id=$1 AND user_id=$2`, id, r.Principal.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("OAuthConnection", id)
	}
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, r.Principal.UserID); err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, text(pre["family_id"])); err != nil {
		return Result{}, err
	}
	var session string
	sessionErr := tx.QueryRow(ctx, `SELECT id FROM device_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, text(pre["session_id"]), r.Principal.UserID).Scan(&session)
	if sessionErr != nil && !errors.Is(sessionErr, pgx.ErrNoRows) {
		return Result{}, sessionErr
	}
	var revoked *time.Time
	err = tx.QueryRow(ctx, `SELECT revoked_at FROM native_go.oauth_grants WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, r.Principal.UserID).Scan(&revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, notFound("OAuthConnection", id)
	}
	if err != nil {
		return Result{}, err
	}
	if revoked == nil {
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, id); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_access SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id=$1`, id); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_refresh SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id=$1`, id); err != nil {
			return Result{}, err
		}
		if err = appendOAuthUserChange(ctx, tx, r.Principal.UserID, id, Object{}, "delete"); err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"success": true})
}

func (s *Server) getPersonalAIUsage(_ context.Context, _ *Request) (Result, error) {
	// Task results currently retain provider payloads without normalized token,
	// model-price, or reconciliation records. Do not report a fabricated quota.
	return Result{Status: http.StatusOK, Body: Object{
		"data": []Object{}, "availability": "unavailable", "reasonCode": "AI_USAGE_ACCOUNTING_NOT_IMPLEMENTED",
	}}, nil
}

func (s *Server) createPersonalVoiceTextRun(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "personal_access_token" {
		return Result{}, apiError(401, "PERSONAL_TOKEN_REQUIRED", "A personal voice submission token is required")
	}
	babyID := text(r.Body["babyId"])
	message := text(r.Body["message"])
	messageID := text(r.Body["clientRequestId"])
	if strings.TrimSpace(message) == "" {
		return Result{}, invalid("Message cannot be blank")
	}
	if idempotencyKey := strings.TrimSpace(r.HTTP.Header.Get("Idempotency-Key")); idempotencyKey != "" && idempotencyKey != messageID {
		return Result{}, apiError(409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key must match clientRequestId")
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, r.Principal.UserID); err != nil {
		return Result{}, err
	}
	if err = validatePersonalAccessToken(ctx, tx, r.Principal, "voice:submit", true); err != nil {
		return Result{}, err
	}
	scope, err := babyScope(ctx, tx, r.Principal.UserID, babyID, false)
	if err != nil {
		return Result{}, err
	}
	if _, err = nativeProviderConfiguration(); err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, scope.FamilyID); err != nil {
		return Result{}, err
	}
	scope, err = babyScope(ctx, tx, r.Principal.UserID, babyID, false)
	if err != nil {
		return Result{}, err
	}
	if err = nativeTaskOwner(ctx, tx, nativeTaskInput{Version: 1, UserID: r.Principal.UserID, FamilyID: scope.FamilyID, BabyID: babyID}, false); err != nil {
		return Result{}, err
	}

	previous, err := one(ctx, tx, `SELECT to_jsonb(m)||jsonb_build_object('session',to_jsonb(a))
		FROM ai_messages m JOIN ai_sessions a ON a.id=m.session_id WHERE m.id=$1`, messageID)
	if err == nil {
		session := obj(previous["session"])
		if text(previous["role"]) != "user" || text(previous["content"]) != message ||
			text(session["user_id"]) != r.Principal.UserID || text(session["baby_id"]) != babyID {
			return Result{}, apiError(409, "CLIENT_MESSAGE_CONFLICT", "Client request identifier is already used")
		}
		existing, lookupErr := one(ctx, tx, `SELECT to_jsonb(t)||jsonb_build_object('payload',o.payload)
			FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
			WHERE t.kind='ai_chat_run' AND t.owner_scope=$1
			AND o.payload->'__native'->>'clientMessageId'=$2 AND o.payload->'__native'->>'sessionId'=$3 LIMIT 1`,
			"user:"+r.Principal.UserID, messageID, text(session["id"]))
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			return Result{}, apiError(409, "CLIENT_MESSAGE_CONFLICT", "Client request has no replayable task")
		}
		if lookupErr != nil {
			return Result{}, lookupErr
		}
		run, lookupErr := readOwnedAIRun(ctx, tx, r.Principal.UserID, text(existing["id"]))
		if lookupErr != nil {
			return Result{}, lookupErr
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return Result{Status: http.StatusAccepted, Body: envelope(aiRunReadDTO(run))}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}

	input := nativeTaskInput{
		Version: 1, UserID: r.Principal.UserID, FamilyID: scope.FamilyID, BabyID: babyID,
		SessionID: newID(), MessageID: messageID, Message: message,
	}
	id := newID()
	if _, err = tx.Exec(ctx, `INSERT INTO ai_sessions(id,user_id,baby_id,title,context_type,created_at,updated_at)
		VALUES($1,$2,$3,'Siri 语音请求','voice_text',NOW(),NOW())`, input.SessionID, input.UserID, input.BabyID); err != nil {
		return Result{}, err
	}
	if err = enqueueNativeTask(ctx, tx, id, "ai_chat_run", input); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO ai_messages(id,session_id,role,content,created_at)
		VALUES($1,$2,'user',$3,NOW())`, input.MessageID, input.SessionID, input.Message); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO ai_runs(id,session_id,user_id,baby_id,last_event_seq,created_at,updated_at)
		VALUES($1,$2,$3,$4,0,NOW(),NOW())`, id, input.SessionID, input.UserID, input.BabyID); err != nil {
		return Result{}, err
	}
	if err = appendNativeRunEvent(ctx, tx, id, "queued", Object{"clientMessageId": messageID, "attempt": 1}); err != nil {
		return Result{}, err
	}
	run, err := readOwnedAIRun(ctx, tx, r.Principal.UserID, id)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusAccepted, Body: envelope(aiRunReadDTO(run))}, nil
}

func (s *Server) getPersonalVoiceTextRun(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.AuthKind != "personal_access_token" {
		return Result{}, apiError(401, "PERSONAL_TOKEN_REQUIRED", "A personal voice submission token is required")
	}
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		if err := validatePersonalAccessToken(ctx, q, r.Principal, "voice:submit", false); err != nil {
			return Result{}, err
		}
		run, err := readOwnedAIRun(ctx, q, r.Principal.UserID, r.Params["id"])
		if err != nil {
			return Result{}, err
		}
		return ok(aiRunReadDTO(run))
	})
}
