package backend

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerAIRunCommands() {
	s.Register("createAiRun", false, s.createNativeAIRun)
	s.Register("confirmAiRun", false, s.confirmNativeAIRun)
	s.Register("cancelAiRun", false, s.cancelNativeAIRun)
	s.Register("retryAiRun", false, s.retryNativeAIRun)
	s.Register("createVoiceRun", false, func(ctx context.Context, r *Request) (Result, error) {
		return s.createAuxiliaryRun(ctx, r, "voice_transcription")
	})
	s.Register("createDailySummaryRun", false, func(ctx context.Context, r *Request) (Result, error) {
		return s.createAuxiliaryRun(ctx, r, "daily_summary_synthesis")
	})
	s.Register("createMedicalOcrRun", false, func(ctx context.Context, r *Request) (Result, error) {
		return s.createAuxiliaryRun(ctx, r, "medical_ocr")
	})
}

func taskAttachments(ctx context.Context, q Querier, input nativeTaskInput, kind string) ([]Object, error) {
	if len(input.AttachmentIDs) > 16 {
		return nil, invalid("Too many attachments")
	}
	ids := append([]string{}, input.AttachmentIDs...)
	sort.Strings(ids)
	out := make([]Object, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return nil, invalid("Duplicate attachment")
		}
		seen[id] = true
		row, err := attachmentRow(ctx, q, id, false)
		if err != nil {
			return nil, err
		}
		if err = authorizeAttachment(ctx, q, input.UserID, row, false, false); err != nil {
			return nil, err
		}
		if text(row["status"]) != "ready" {
			return nil, apiError(400, "ATTACHMENT_NOT_READY", "Task requires a verified ready attachment")
		}
		if input.FamilyID != "" && text(row["family_id"]) != input.FamilyID {
			return nil, apiError(403, "FAMILY_ACCESS_DENIED", "Attachment family does not match task")
		}
		if input.BabyID != "" && text(row["baby_id"]) != input.BabyID {
			return nil, apiError(403, "ATTACHMENT_ACCESS_DENIED", "Attachment baby does not match task")
		}
		mime := text(row["mime_type"])
		switch kind {
		case "voice_transcription":
			if !strings.HasPrefix(mime, "audio/") {
				return nil, invalid("Voice tasks require an audio attachment")
			}
		case "medical_ocr":
			if !strings.HasPrefix(mime, "image/") && mime != "application/pdf" {
				return nil, invalid("OCR requires an image or PDF attachment")
			}
		case "ai_chat_run":
			if !strings.HasPrefix(mime, "image/") && mime != "application/pdf" {
				return nil, invalid("Chat attachments must be images or PDFs")
			}
		}
		out = append(out, row)
	}
	return out, nil
}

func nativeSubmissionScope(ctx context.Context, q Querier, user, baby string) (nativeTaskInput, error) {
	input := nativeTaskInput{Version: 1, UserID: user}
	if baby != "" {
		scope, err := babyScope(ctx, q, user, baby, false)
		if err != nil {
			return input, err
		}
		input.BabyID, input.FamilyID = scope.BabyID, scope.FamilyID
	}
	if err := nativeTaskOwner(ctx, q, input, false); err != nil {
		return input, err
	}
	return input, nil
}
func lockSubmissionScope(ctx context.Context, tx pgx.Tx, input nativeTaskInput) error {
	if input.FamilyID != "" {
		if _, err := lockFamily(ctx, tx, input.FamilyID); err != nil {
			return err
		}
	}
	return nativeTaskOwner(ctx, tx, input, false)
}
func stringList(value any) ([]string, error) {
	if value == nil {
		return []string{}, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, invalid("Expected an array")
	}
	out := make([]string, len(items))
	for i, item := range items {
		v, ok := item.(string)
		if !ok || v == "" {
			return nil, invalid("Expected nonempty string items")
		}
		out[i] = v
	}
	return out, nil
}
func (s *Server) createNativeAIRun(ctx context.Context, r *Request) (Result, error) {
	session, err := ownedCoreAISession(ctx, s.DB, r.Principal.UserID, r.Params["id"], false)
	if err != nil {
		return Result{}, err
	}
	input, err := nativeSubmissionScope(ctx, s.DB, r.Principal.UserID, text(session["baby_id"]))
	if err != nil {
		return Result{}, err
	}
	if _, err = nativeProviderConfiguration(); err != nil {
		return Result{}, err
	}
	input.SessionID, input.MessageID, input.Message = text(session["id"]), text(r.Body["clientMessageId"]), text(r.Body["message"])
	input.AttachmentIDs, err = stringList(r.Body["attachmentIds"])
	if err != nil {
		return Result{}, err
	}
	if len(input.AttachmentIDs) > 0 {
		if _, err = requireObjectStore(s); err != nil {
			return Result{}, err
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockSubmissionScope(ctx, tx, input); err != nil {
		return Result{}, err
	}
	if _, err = ownedCoreAISession(ctx, tx, input.UserID, input.SessionID, true); err != nil {
		return Result{}, err
	}
	if _, err = taskAttachments(ctx, tx, input, "ai_chat_run"); err != nil {
		return Result{}, err
	}
	previous, err := one(ctx, tx, `SELECT to_jsonb(m) FROM ai_messages m WHERE id=$1`, input.MessageID)
	if err == nil {
		if text(previous["session_id"]) != input.SessionID || text(previous["content"]) != input.Message || text(previous["role"]) != "user" {
			return Result{}, apiError(409, "CLIENT_MESSAGE_CONFLICT", "Message identifier is already used")
		}
		existing, err := one(ctx, tx, `SELECT to_jsonb(t)||jsonb_build_object('payload',o.payload) FROM task_executions t
			JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
			WHERE t.owner_scope=$1 AND o.payload->'__native'->>'clientMessageId'=$2
			AND o.payload->'__native'->>'sessionId'=$3 LIMIT 1`, "user:"+input.UserID, input.MessageID, input.SessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, apiError(409, "CLIENT_MESSAGE_CONFLICT", "Message is not associated with a replayable task")
		}
		if err != nil {
			return Result{}, err
		}
		old, e := decodeNativeTaskInput(existing)
		if e != nil {
			return Result{}, e
		}
		oldHash, e := snapshotHash(old.AttachmentIDs)
		if e != nil {
			return Result{}, e
		}
		newHash, e := snapshotHash(input.AttachmentIDs)
		if e != nil {
			return Result{}, e
		}
		if oldHash != newHash {
			return Result{}, apiError(409, "CLIENT_MESSAGE_CONFLICT", "Message attachments changed")
		}
		run, e := readOwnedAIRun(ctx, tx, input.UserID, text(existing["id"]))
		if e != nil {
			return Result{}, e
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return Result{Status: 202, Body: envelope(aiRunReadDTO(run))}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	id := newID()
	if err = enqueueNativeTask(ctx, tx, id, "ai_chat_run", input); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO ai_messages(id,session_id,role,content,image,tools_json,created_at) VALUES($1,$2,'user',$3,NULL,NULL,NOW())`, input.MessageID, input.SessionID, input.Message); err != nil {
		return Result{}, err
	}
	var baby any
	if input.BabyID != "" {
		baby = input.BabyID
	}
	if _, err = tx.Exec(ctx, `INSERT INTO ai_runs(id,session_id,user_id,baby_id,last_event_seq,created_at,updated_at) VALUES($1,$2,$3,$4,0,NOW(),NOW())`, id, input.SessionID, input.UserID, baby); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_sessions SET updated_at=NOW() WHERE id=$1`, input.SessionID); err != nil {
		return Result{}, err
	}
	if err = appendNativeRunEvent(ctx, tx, id, "queued", Object{"clientMessageId": input.MessageID, "attempt": 1}); err != nil {
		return Result{}, err
	}
	run, err := readOwnedAIRun(ctx, tx, input.UserID, id)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: 202, Body: envelope(aiRunReadDTO(run))}, nil
}

func (s *Server) createAuxiliaryRun(ctx context.Context, r *Request, kind string) (Result, error) {
	baby := r.Params["babyId"]
	if baby == "" {
		baby = text(r.Body["babyId"])
	}
	if kind == "medical_ocr" {
		row, err := s.readNativeAttachment(ctx, r.Principal.UserID, text(r.Body["attachmentId"]), false, false)
		if err != nil {
			return Result{}, err
		}
		baby = text(row["baby_id"])
		if baby == "" {
			return Result{}, invalid("Medical OCR requires a baby-scoped attachment")
		}
	}
	input, err := nativeSubmissionScope(ctx, s.DB, r.Principal.UserID, baby)
	if err != nil {
		return Result{}, err
	}
	if _, err = nativeProviderConfiguration(); err != nil {
		return Result{}, err
	}
	if kind == "daily_summary_synthesis" {
		input.TargetDate = text(r.Body["targetDate"])
	} else {
		input.AttachmentIDs = []string{text(r.Body["attachmentId"])}
		if _, err = requireObjectStore(s); err != nil {
			return Result{}, err
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockSubmissionScope(ctx, tx, input); err != nil {
		return Result{}, err
	}
	if _, err = taskAttachments(ctx, tx, input, kind); err != nil {
		return Result{}, err
	}
	key := r.HTTP.Header.Get("Idempotency-Key")
	if kind == "voice_transcription" {
		key = text(r.Body["clientRequestId"])
	}
	if len(key) > 200 {
		return Result{}, invalid("Idempotency key is too long")
	}
	hash, err := snapshotHash(Object{"kind": kind, "input": input})
	if err != nil {
		return Result{}, err
	}
	// Family lock serializes these baby-scoped submissions and their receipt.
	receiptKey := "native-task:" + kind + ":" + key
	if key != "" {
		row, e := one(ctx, tx, `SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`, input.UserID, input.FamilyID, receiptKey)
		if e == nil {
			if strings.TrimSpace(text(row["request_hash"])) != hash {
				return Result{}, reusedKey(key)
			}
			if err = tx.Commit(ctx); err != nil {
				return Result{}, err
			}
			return Result{Status: 202, Body: envelope(row["response_body"])}, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return Result{}, e
		}
	}
	id := newID()
	input.SessionID, input.MessageID = newID(), newID()
	title := "语音记录"
	if kind == "medical_ocr" {
		title = "医疗文档识别"
	} else if kind == "daily_summary_synthesis" {
		title = "日报 " + input.TargetDate
	}
	input.Message = title
	if _, err = tx.Exec(ctx, `INSERT INTO ai_sessions(id,user_id,baby_id,title,context_type,created_at,updated_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW())`, input.SessionID, input.UserID, input.BabyID, title, kind); err != nil {
		return Result{}, err
	}
	if err = enqueueNativeTask(ctx, tx, id, kind, input); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO ai_messages(id,session_id,role,content,created_at) VALUES($1,$2,'user',$3,NOW())`, input.MessageID, input.SessionID, title); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO ai_runs(id,session_id,user_id,baby_id,last_event_seq,created_at,updated_at) VALUES($1,$2,$3,$4,0,NOW(),NOW())`, id, input.SessionID, input.UserID, input.BabyID); err != nil {
		return Result{}, err
	}
	if err = appendNativeRunEvent(ctx, tx, id, "queued", Object{"attempt": 1}); err != nil {
		return Result{}, err
	}
	result := Object{"runId": id, "status": "queued"}
	if key != "" {
		raw, _ := jsonText(result)
		if _, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,response_body,completed_at) VALUES($1,$2,$3,$4,202,$5::jsonb,NOW())`, input.UserID, input.FamilyID, receiptKey, hash, raw); err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: 202, Body: envelope(result)}, nil
}

func (s *Server) lockOwnedRun(ctx context.Context, tx pgx.Tx, userID, id string) (Object, error) {
	initial, err := readOwnedAIRun(ctx, tx, userID, id)
	if err != nil {
		return nil, err
	}
	if baby := text(initial["baby_id"]); baby != "" {
		scope, e := babyScope(ctx, tx, userID, baby, false)
		if e != nil {
			return nil, e
		}
		if _, e = lockFamily(ctx, tx, scope.FamilyID); e != nil {
			return nil, e
		}
	}
	var locked string
	if err := tx.QueryRow(ctx, `SELECT id FROM task_executions WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
		return nil, err
	}
	return readOwnedAIRun(ctx, tx, userID, id)
}
func cancelTaskTx(ctx context.Context, tx pgx.Tx, id string) error {
	row, err := one(ctx, tx, `SELECT to_jsonb(t) FROM task_executions t WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return err
	}
	switch text(row["status"]) {
	case "succeeded", "failed", "cancelled":
		return nil
	}
	// A terminal CAS fences old workers immediately. Provider cancellation is
	// cooperative, but a late provider response can never publish business data.
	tag, err := tx.Exec(ctx, `UPDATE task_executions SET status='cancelled',cancel_requested_at=NOW(),lease_owner=NULL,
        lease_expires_at=NULL,fence_token=fence_token+1,updated_at=NOW() WHERE id=$1 AND fence_token<9223372036854775807`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return apiError(409, "CONCURRENCY_CONFLICT", "Task fencing range exhausted")
	}
	if _, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='closed',terminal_at=NOW() WHERE aggregate_id=$1`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_runs SET proposed_plan=NULL,finished_at=NOW(),error_code='TASK_CANCELLED',updated_at=NOW() WHERE id=$1`, id); err != nil {
		return err
	}
	return appendNativeRunEvent(ctx, tx, id, "run_cancelled", Object{"attempt": max(int64(1), integer(row["attempt"]))})
}
func (s *Server) cancelNativeAIRun(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if _, err = s.lockOwnedRun(ctx, tx, r.Principal.UserID, r.Params["id"]); err != nil {
		return Result{}, err
	}
	if err = cancelTaskTx(ctx, tx, r.Params["id"]); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: 200, Body: success()}, nil
}
func (s *Server) retryNativeAIRun(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	run, err := s.lockOwnedRun(ctx, tx, r.Principal.UserID, r.Params["id"])
	if err != nil {
		return Result{}, err
	}
	task := obj(run["__task"])
	kind := text(task["kind"])
	if (kind != "ai_chat_run" && kind != "voice_transcription" && kind != "medical_ocr" && kind != "daily_summary_synthesis") || (text(task["status"]) != "failed" && text(task["status"]) != "cancelled") {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Only failed or cancelled executable runs can be retried")
	}
	if _, err = nativeProviderConfiguration(); err != nil {
		return Result{}, err
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_outbox WHERE aggregate_id=$1 AND phase_key='native-initial' AND payload ? '__native')`, r.Params["id"]).Scan(&exists); err != nil {
		return Result{}, err
	}
	if !exists {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Run has no compatible retained input")
	}
	next := max(int64(1), integer(task["attempt"])) + 1
	if integer(task["fence_token"]) >= 9223372036854775807 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Task fencing range exhausted")
	}
	if next > 32 {
		return Result{}, apiError(409, "ATTEMPTS_EXHAUSTED", "Create a new run after 32 explicit attempts")
	}
	if _, err = tx.Exec(ctx, `UPDATE task_executions SET status='queued',attempt=$2,max_attempts=GREATEST(max_attempts,$2),
		fence_token=fence_token+1,cancel_requested_at=NULL,lease_owner=NULL,lease_expires_at=NULL,progress=NULL,result_ref=NULL,error_details=NULL,updated_at=NOW() WHERE id=$1`, r.Params["id"], next); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE task_outbox SET dispatch_state='active',next_dispatch_at=NOW(),terminal_at=NULL WHERE aggregate_id=$1 AND phase_key='native-initial'`, r.Params["id"]); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_runs SET error_code=NULL,error_message=NULL,proposed_plan=NULL,result_summary=NULL,started_at=NULL,finished_at=NULL,updated_at=NOW() WHERE id=$1`, r.Params["id"]); err != nil {
		return Result{}, err
	}
	if err = appendNativeRunEvent(ctx, tx, r.Params["id"], "attempt_restarted", Object{"attempt": next}); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: 202, Body: envelope(Object{"runId": r.Params["id"], "newAttempt": next, "status": "queued"})}, nil
}

func (s *Server) confirmNativeAIRun(ctx context.Context, r *Request) (Result, error) {
	run, err := readOwnedAIRun(ctx, s.DB, r.Principal.UserID, r.Params["id"])
	if err != nil {
		return Result{}, err
	}
	scope, err := babyScope(ctx, s.DB, r.Principal.UserID, text(run["baby_id"]), true)
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	// Family -> task -> run, shared by the completion and cancellation protocol.
	if _, err = lockFamily(ctx, tx, scope.FamilyID); err != nil {
		return Result{}, err
	}
	run, err = s.lockOwnedRun(ctx, tx, r.Principal.UserID, r.Params["id"])
	if err != nil {
		return Result{}, err
	}
	current, err := babyScope(ctx, tx, r.Principal.UserID, scope.BabyID, true)
	if err != nil {
		return Result{}, err
	}
	if current.FamilyID != scope.FamilyID {
		return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Run scope changed")
	}
	task := obj(run["__task"])
	ids, err := stringList(r.Body["actionIds"])
	if err != nil {
		return Result{}, err
	}
	requested := map[string]bool{}
	for _, id := range ids {
		if requested[id] {
			return Result{}, apiError(400, "AI_ACTION_INVALID", "Duplicate action identifier")
		}
		requested[id] = true
	}
	requestDigest, err := snapshotHash(Object{"planHash": r.Body["planHash"], "actionIds": ids})
	if err != nil {
		return Result{}, err
	}
	if text(task["status"]) == "succeeded" {
		result := obj(task["result_ref"])
		if text(result["confirmationHash"]) == requestDigest {
			return ok(Object{"runId": r.Params["id"], "status": "succeeded", "appliedActionCount": integer(result["appliedActionCount"])})
		}
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Run was already completed")
	}
	if text(task["status"]) != "awaiting_confirmation" || task["cancel_requested_at"] != nil {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Run is not awaiting confirmation")
	}
	plan := obj(run["proposed_plan"])
	actions, validActions := plan["actions"].([]any)
	if !validActions || len(actions) == 0 || len(actions) > 32 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Invalid persisted plan")
	}
	planHash, err := canonicalNativeHash(actions)
	if err != nil {
		return Result{}, err
	}
	if subtle.ConstantTimeCompare([]byte(planHash), []byte(text(plan["planHash"]))) != 1 || subtle.ConstantTimeCompare([]byte(planHash), []byte(text(r.Body["planHash"]))) != 1 {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Plan hash mismatch")
	}
	expiry, err := asTime(plan["expiresAt"])
	if err != nil || !expiry.After(time.Now()) {
		return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Plan expired")
	}
	selected := []Object{}
	for _, candidate := range actions {
		action := obj(candidate)
		if requested[text(action["actionId"])] {
			selected = append(selected, action)
		}
	}
	if len(selected) != len(ids) || len(selected) != 1 || text(selected[0]["entityType"]) != "feeding" || text(selected[0]["operation"]) != "create" {
		return Result{}, apiError(400, "AI_ACTION_UNSUPPORTED", "Only one feeding create action is executable in the current contract")
	}
	action := selected[0]
	actionID := text(action["actionId"])
	body := copyObject(obj(action["payload"]))
	for _, key := range []string{"userId", "familyId", "babyId", "id", "source", "sourceAgent"} {
		delete(body, key)
	}
	// Decimal numbers in provider output are normalized at this proposal-only
	// boundary; scalar body types still receive full domain validation.
	if v := body["amountMl"]; v != nil {
		body["amountMl"] = text(v)
	}
	body["source"], body["sourceAgent"] = "ai_chat", "ai_chat"
	key := "native-confirm:" + r.Params["id"] + ":" + actionID
	hash, err := snapshotHash(Object{"runId": r.Params["id"], "planHash": planHash, "action": action})
	if err != nil {
		return Result{}, err
	}
	command, err := s.prepareRecordCommand(r.Principal, scope, "feeding", actionID, "create", key, hash, hash, 0, body, "ai_chat")
	if err != nil {
		return Result{}, err
	}
	outcome, err := s.executeRecordCommandTx(ctx, tx, r, command)
	if err != nil {
		return Result{}, err
	}
	for _, event := range []struct {
		kind    string
		payload Object
	}{
		{"tool_started", Object{"actionId": actionID}},
		{"tool_succeeded", Object{"actionId": actionID, "result": careDTO(careSpecs[0], outcome.Entity)}},
		{"run_succeeded", Object{"actionIds": ids}},
	} {
		event.payload["attempt"] = max(int64(1), integer(task["attempt"]))
		if err = appendNativeRunEvent(ctx, tx, r.Params["id"], event.kind, event.payload); err != nil {
			return Result{}, err
		}
	}
	lease := nativeTaskLease{ID: r.Params["id"]}
	result := Object{"confirmationHash": requestDigest, "appliedActionCount": 1, "actionIds": ids, "feedingId": outcome.Entity["id"]}
	if err = terminalNativeTask(ctx, tx, lease, "succeeded", result); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_runs SET proposed_plan=NULL,result_summary=$2,finished_at=NOW(),updated_at=NOW() WHERE id=$1`, r.Params["id"], "已执行："+text(action["summary"])); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(Object{"runId": r.Params["id"], "status": "succeeded", "appliedActionCount": 1})
}

func dailySummaryErrorBoundary(h Handler) Handler {
	return func(ctx context.Context, r *Request) (Result, error) {
		result, err := h(ctx, r)
		e := normalizedError(err)
		if err != nil && e.Status == http.StatusForbidden && (e.Code == "FAMILY_ACCESS_DENIED" || e.Code == "BABY_ACCESS_DENIED" || e.Code == "BABY_NOT_FOUND") {
			return Result{}, apiError(403, "NOT_A_MEMBER", "Access denied to baby")
		}
		return result, err
	}
}
