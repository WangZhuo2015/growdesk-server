package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	deviceSyncBindingHeader        = "X-Device-Sync-Binding-ID"
	deviceSyncGenerationHeader     = "X-Device-Sync-Generation"
	deviceSyncImportManifestPrefix = "growdesk-device-sync-import-v1\n"
)

func (s *Server) registerDeviceSyncBindings() {
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings", s.enrollDeviceSyncBinding)
	s.registerDeclared(http.MethodGet, "/api/v1/sync/device-bindings", s.listDeviceSyncBindings)
	s.registerDeclared(http.MethodGet, "/api/v1/sync/device-bindings/{bindingId}", s.getDeviceSyncBinding)
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings/{bindingId}/import-plans", s.createDeviceSyncImportPlan)
	s.registerDeclared(http.MethodGet, "/api/v1/sync/device-bindings/{bindingId}/import-plans/{importId}", s.getDeviceSyncImportPlan)
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings/{bindingId}/import-plans/{importId}/chunks", s.applyDeviceSyncImportChunk)
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings/{bindingId}/activate", s.activateDeviceSyncBinding)
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings/{bindingId}/pause", s.pauseDeviceSyncBinding)
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings/{bindingId}/resume", s.resumeDeviceSyncBinding)
	s.registerDeclared(http.MethodPost, "/api/v1/sync/device-bindings/{bindingId}/revoke", s.revokeDeviceSyncBinding)
}

func deviceSyncBindingDTO(row Object) Object {
	return Object{
		"id": row["id"], "userId": row["user_id"], "installationId": row["installation_id"],
		"localVaultId": row["local_vault_id"], "familyId": row["family_id"], "status": row["status"],
		"generation": strconv.FormatInt(integer(row["generation"]), 10), "consentVersion": row["consent_version"],
		"createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"]),
		"activatedAt": isoValue(row["activated_at"]),
	}
}

func deviceSyncPlanDTO(plan Object, chunks []Object) Object {
	items := make([]Object, 0, len(chunks))
	for _, chunk := range chunks {
		items = append(items, Object{
			"chunkId": chunk["chunk_id"], "index": integer(chunk["chunk_index"]),
			"requestHash": strings.TrimSpace(text(chunk["request_hash"])), "itemCount": integer(chunk["item_count"]),
			"status": chunk["status"],
		})
	}
	return Object{
		"id": plan["id"], "bindingId": plan["binding_id"], "generation": strconv.FormatInt(integer(plan["generation"]), 10),
		"consentVersion": plan["consent_version"], "manifestHash": strings.TrimSpace(text(plan["manifest_hash"])),
		"status": plan["status"], "chunks": items, "createdAt": isoValue(plan["created_at"]),
		"activatedAt": isoValue(plan["activated_at"]), "activatedGeneration": nullableIntString(plan["activated_generation"]),
	}
}

func nullableIntString(value any) any {
	if value == nil {
		return nil
	}
	return strconv.FormatInt(integer(value), 10)
}

func selectDeviceSyncBinding(ctx context.Context, q Querier, bindingID, userID string, lock string) (Object, error) {
	query := `SELECT to_jsonb(b) FROM device_sync_bindings b WHERE b.id=$1 AND b.user_id=$2`
	if lock != "" {
		query += " FOR " + lock
	}
	row, err := one(ctx, q, query, bindingID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiError(404, "DEVICE_SYNC_BINDING_NOT_FOUND", "Device sync binding not found")
	}
	return row, err
}

func requireDeviceSyncFamilyWriter(ctx context.Context, q Querier, userID, familyID string) error {
	role, err := familyRole(ctx, q, userID, familyID)
	if err != nil {
		if normalizedError(err).Status == 403 {
			return apiError(403, "DEVICE_SYNC_FAMILY_ACCESS_DENIED", "The authenticated account is not an active member of the selected family")
		}
		return err
	}
	if role == "viewer" {
		return apiError(403, "DEVICE_SYNC_FAMILY_READ_ONLY", "Family viewers cannot enable device synchronization")
	}
	return nil
}

func lockAndRequireDeviceSyncFamily(ctx context.Context, tx pgx.Tx, userID, familyID string) error {
	if err := requireDeviceSyncFamilyWriter(ctx, tx, userID, familyID); err != nil {
		return err
	}
	if _, err := lockFamily(ctx, tx, familyID); err != nil {
		return err
	}
	return requireDeviceSyncFamilyWriter(ctx, tx, userID, familyID)
}

func (s *Server) enrollDeviceSyncBinding(ctx context.Context, r *Request) (Result, error) {
	userID, familyID := r.Principal.UserID, text(r.Body["familyId"])
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockAndRequireDeviceSyncFamily(ctx, tx, userID, familyID); err != nil {
		return Result{}, err
	}
	installationID, localVaultID, consent := text(r.Body["installationId"]), text(r.Body["localVaultId"]), text(r.Body["consentVersion"])
	// This is a read-only lookup. The family row lock above serializes a first
	// enrollment; taking the existing binding row lock here would invert the
	// binding-then-family order used by transitions, imports, and sync commands.
	row, err := one(ctx, tx, `SELECT to_jsonb(b) FROM device_sync_bindings b
		WHERE b.user_id=$1 AND b.installation_id=$2 AND b.local_vault_id=$3 AND b.family_id=$4`,
		userID, installationID, localVaultID, familyID)
	if err == nil {
		if text(row["consent_version"]) != consent {
			return Result{}, apiError(409, "DEVICE_SYNC_CONSENT_VERSION_MISMATCH", "This local vault already has a binding with a different consent version")
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return ok(deviceSyncBindingDTO(row))
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	row, err = one(ctx, tx, `INSERT INTO device_sync_bindings(id,user_id,installation_id,local_vault_id,family_id,status,generation,consent_version,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,'pending',1,$6,NOW(),NOW()) RETURNING to_jsonb(device_sync_bindings)`,
		newID(), userID, installationID, localVaultID, familyID, consent)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return created(deviceSyncBindingDTO(row))
}

func (s *Server) listDeviceSyncBindings(ctx context.Context, r *Request) (Result, error) {
	familyID := r.HTTP.URL.Query().Get("familyId")
	var rows []Object
	var err error
	if familyID == "" {
		rows, err = many(ctx, s.DB, `SELECT to_jsonb(b) FROM device_sync_bindings b WHERE b.user_id=$1 ORDER BY b.updated_at DESC,b.id LIMIT 500`, r.Principal.UserID)
	} else {
		rows, err = many(ctx, s.DB, `SELECT to_jsonb(b) FROM device_sync_bindings b WHERE b.user_id=$1 AND b.family_id=$2 ORDER BY b.updated_at DESC,b.id LIMIT 500`, r.Principal.UserID, familyID)
	}
	if err != nil {
		return Result{}, err
	}
	items := make([]Object, 0, len(rows))
	for _, row := range rows {
		items = append(items, deviceSyncBindingDTO(row))
	}
	return ok(items)
}

func (s *Server) getDeviceSyncBinding(ctx context.Context, r *Request) (Result, error) {
	row, err := selectDeviceSyncBinding(ctx, s.DB, r.Params["bindingId"], r.Principal.UserID, "")
	if err != nil {
		return Result{}, err
	}
	return ok(deviceSyncBindingDTO(row))
}

func deviceSyncActionHash(operation, bindingID string, raw []byte) string {
	return hashText("growdesk-device-sync-action-v1\n" + operation + "\n" + bindingID + "\n" + string(raw))
}

func deviceSyncExpectedGeneration(r *Request) (int64, error) {
	return syncPosition(text(r.Body["generation"]))
}

func deviceSyncCommandGeneration(r *Request) (string, int64, error) {
	bindingID := r.HTTP.Header.Get(deviceSyncBindingHeader)
	generationText := r.HTTP.Header.Get(deviceSyncGenerationHeader)
	if bindingID == "" || generationText == "" {
		return "", 0, apiError(400, "DEVICE_SYNC_CONTEXT_REQUIRED", "Device sync binding and generation headers are required")
	}
	generation, err := syncPosition(generationText)
	if err != nil {
		return "", 0, err
	}
	if generation < 1 {
		return "", 0, apiError(400, "DEVICE_SYNC_GENERATION_INVALID", "Device sync generation must be positive")
	}
	return bindingID, generation, nil
}

func validateDeviceSyncAdmission(ctx context.Context, q Querier, userID, bindingID string, generation int64, familyID string, lock string) (Object, error) {
	binding, err := selectDeviceSyncBinding(ctx, q, bindingID, userID, lock)
	if err != nil {
		return nil, err
	}
	if text(binding["status"]) != "active" || integer(binding["generation"]) != generation {
		return nil, apiError(409, "DEVICE_SYNC_BINDING_STALE", "Device sync binding is inactive or its generation is stale")
	}
	if familyID != "" && text(binding["family_id"]) != familyID {
		return nil, apiError(403, "DEVICE_SYNC_BINDING_SCOPE_MISMATCH", "The command family does not match the device sync binding")
	}
	return binding, nil
}

func validatePendingDeviceSyncBinding(ctx context.Context, q Querier, userID, bindingID string, generation int64) (Object, error) {
	binding, err := selectDeviceSyncBinding(ctx, q, bindingID, userID, "UPDATE")
	if err != nil {
		return nil, err
	}
	if text(binding["status"]) != "pending" || integer(binding["generation"]) != generation {
		return nil, apiError(409, "DEVICE_SYNC_BINDING_STALE", "Import operations require the current pending binding generation")
	}
	return binding, nil
}

func sha256Raw(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

type deviceSyncChunkDescriptor struct {
	ID               string
	Index, ItemCount int
	RequestHash      string
}

func parseDeviceSyncChunkDescriptors(value any) ([]deviceSyncChunkDescriptor, int, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, 0, invalid("Import chunks must be an array")
	}
	if len(items) > 10000 {
		return nil, 0, invalid("Import plan has too many chunks")
	}
	seenID := map[string]bool{}
	total := 0
	descriptors := make([]deviceSyncChunkDescriptor, 0, len(items))
	for i, raw := range items {
		item := obj(raw)
		index, count := int(integer(item["index"])), int(integer(item["itemCount"]))
		id, digest := text(item["chunkId"]), text(item["requestHash"])
		if index != i || id == "" || seenID[id] || len(digest) != 64 || count < 1 || count > 50 {
			return nil, 0, apiError(400, "DEVICE_SYNC_IMPORT_MANIFEST_INVALID", "Chunk indexes, IDs, hashes and item counts must be valid and contiguous")
		}
		seenID[id] = true
		if total > 500000-count {
			return nil, 0, apiError(400, "DEVICE_SYNC_IMPORT_MANIFEST_INVALID", "Import record count exceeds the supported limit")
		}
		total += count
		descriptors = append(descriptors, deviceSyncChunkDescriptor{ID: id, Index: index, ItemCount: count, RequestHash: digest})
	}
	return descriptors, total, nil
}

func deviceSyncImportManifestHash(chunks []deviceSyncChunkDescriptor) string {
	ordered := append([]deviceSyncChunkDescriptor(nil), chunks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Index < ordered[j].Index })
	var b strings.Builder
	b.WriteString(deviceSyncImportManifestPrefix)
	for _, chunk := range ordered {
		fmt.Fprintf(&b, "%d:%s:%s:%d\n", chunk.Index, chunk.ID, chunk.RequestHash, chunk.ItemCount)
	}
	return hashText(b.String())
}

func (s *Server) createDeviceSyncImportPlan(ctx context.Context, r *Request) (Result, error) {
	bindingID, generation, err := deviceSyncCommandGeneration(r)
	if err != nil {
		return Result{}, err
	}
	if bindingID != r.Params["bindingId"] {
		return Result{}, apiError(400, "DEVICE_SYNC_CONTEXT_MISMATCH", "Binding header does not match the requested binding")
	}
	bodyGeneration, err := syncPosition(text(r.Body["generation"]))
	if err != nil || bodyGeneration != generation {
		return Result{}, apiError(409, "DEVICE_SYNC_BINDING_STALE", "Import plan generation does not match the current binding generation")
	}
	descriptors, total, err := parseDeviceSyncChunkDescriptors(r.Body["chunks"])
	if err != nil {
		return Result{}, err
	}
	if deviceSyncImportManifestHash(descriptors) != text(r.Body["manifestHash"]) {
		return Result{}, apiError(400, "DEVICE_SYNC_IMPORT_MANIFEST_INVALID", "Import manifest hash does not match the ordered chunk descriptors")
	}
	userID := r.Principal.UserID
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	binding, err := validatePendingDeviceSyncBinding(ctx, tx, userID, bindingID, generation)
	if err != nil {
		return Result{}, err
	}
	if text(binding["consent_version"]) != text(r.Body["consentVersion"]) {
		return Result{}, apiError(409, "DEVICE_SYNC_CONSENT_VERSION_MISMATCH", "Import consent version does not match the enrolled binding")
	}
	if err = lockAndRequireDeviceSyncFamily(ctx, tx, userID, text(binding["family_id"])); err != nil {
		return Result{}, err
	}
	importID := text(r.Body["importId"])
	plan, planErr := one(ctx, tx, `SELECT to_jsonb(p) FROM device_sync_import_plans p WHERE p.binding_id=$1 AND p.generation=$2 FOR UPDATE`, bindingID, generation)
	if planErr == nil {
		if text(plan["id"]) != importID || text(plan["manifest_hash"]) != text(r.Body["manifestHash"]) || integer(plan["expected_chunk_count"]) != int64(len(descriptors)) || integer(plan["expected_record_count"]) != int64(total) {
			return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_PLAN_CONFLICT", "A different import plan is already recorded for this binding generation")
		}
		chunks, e := many(ctx, tx, `SELECT to_jsonb(c) FROM device_sync_import_chunks c WHERE c.import_id=$1 ORDER BY c.chunk_index`, importID)
		if e != nil {
			return Result{}, e
		}
		if !sameDeviceSyncChunkDescriptors(chunks, descriptors) {
			return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_PLAN_CONFLICT", "Import plan descriptors changed on retry")
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return ok(deviceSyncPlanDTO(plan, chunks))
	}
	if !errors.Is(planErr, pgx.ErrNoRows) {
		return Result{}, planErr
	}
	// A plan ID is principal-independent but unpredictable; if it already exists
	// for another binding, returning conflict avoids disclosing its owner.
	if _, err = tx.Exec(ctx, `INSERT INTO device_sync_import_plans(id,binding_id,generation,consent_version,manifest_hash,expected_chunk_count,expected_record_count,status,created_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,'pending',NOW())`, importID, bindingID, generation, text(r.Body["consentVersion"]), text(r.Body["manifestHash"]), len(descriptors), total); err != nil {
		return Result{}, err
	}
	for _, chunk := range descriptors {
		if _, err = tx.Exec(ctx, `INSERT INTO device_sync_import_chunks(import_id,chunk_id,chunk_index,request_hash,item_count,status)
			VALUES($1,$2,$3,$4,$5,'pending')`, importID, chunk.ID, chunk.Index, chunk.RequestHash, chunk.ItemCount); err != nil {
			return Result{}, err
		}
	}
	plan, err = one(ctx, tx, `SELECT to_jsonb(p) FROM device_sync_import_plans p WHERE p.id=$1`, importID)
	if err != nil {
		return Result{}, err
	}
	chunks, err := many(ctx, tx, `SELECT to_jsonb(c) FROM device_sync_import_chunks c WHERE c.import_id=$1 ORDER BY c.chunk_index`, importID)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return created(deviceSyncPlanDTO(plan, chunks))
}

func sameDeviceSyncChunkDescriptors(rows []Object, expected []deviceSyncChunkDescriptor) bool {
	if len(rows) != len(expected) {
		return false
	}
	for i, row := range rows {
		if text(row["chunk_id"]) != expected[i].ID || int(integer(row["chunk_index"])) != expected[i].Index || int(integer(row["item_count"])) != expected[i].ItemCount || strings.TrimSpace(text(row["request_hash"])) != expected[i].RequestHash {
			return false
		}
	}
	return true
}

func (s *Server) getDeviceSyncImportPlan(ctx context.Context, r *Request) (Result, error) {
	bindingID, importID := r.Params["bindingId"], r.Params["importId"]
	if _, err := selectDeviceSyncBinding(ctx, s.DB, bindingID, r.Principal.UserID, ""); err != nil {
		return Result{}, err
	}
	plan, err := one(ctx, s.DB, `SELECT to_jsonb(p) FROM device_sync_import_plans p WHERE p.id=$1 AND p.binding_id=$2`, importID, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "DEVICE_SYNC_IMPORT_PLAN_NOT_FOUND", "Import plan not found")
	}
	if err != nil {
		return Result{}, err
	}
	chunks, err := many(ctx, s.DB, `SELECT to_jsonb(c) FROM device_sync_import_chunks c WHERE c.import_id=$1 ORDER BY c.chunk_index`, importID)
	if err != nil {
		return Result{}, err
	}
	return ok(deviceSyncPlanDTO(plan, chunks))
}

func (s *Server) pauseDeviceSyncBinding(ctx context.Context, r *Request) (Result, error) {
	return s.transitionDeviceSyncBinding(ctx, r, "pause")
}
func (s *Server) resumeDeviceSyncBinding(ctx context.Context, r *Request) (Result, error) {
	return s.transitionDeviceSyncBinding(ctx, r, "resume")
}
func (s *Server) revokeDeviceSyncBinding(ctx context.Context, r *Request) (Result, error) {
	return s.transitionDeviceSyncBinding(ctx, r, "revoke")
}

func (s *Server) transitionDeviceSyncBinding(ctx context.Context, r *Request, action string) (Result, error) {
	bindingID, userID := r.Params["bindingId"], r.Principal.UserID
	key := r.HTTP.Header.Get("Idempotency-Key")
	hash := deviceSyncActionHash(action, bindingID, r.RawBody)
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	binding, err := selectDeviceSyncBinding(ctx, tx, bindingID, userID, "UPDATE")
	if err != nil {
		return Result{}, err
	}
	receipt, receiptErr := one(ctx, tx, `SELECT to_jsonb(a) FROM device_sync_binding_action_receipts a WHERE a.user_id=$1 AND a.binding_id=$2 AND a.idempotency_key=$3`, userID, bindingID, key)
	if receiptErr == nil {
		if strings.TrimSpace(text(receipt["request_hash"])) != hash {
			return Result{}, apiError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different binding action")
		}
		prior := obj(receipt["response_body"])
		if integer(binding["generation"]) != parseDecimal(prior["generation"]) || text(binding["status"]) != text(prior["status"]) {
			return Result{}, apiError(409, "DEVICE_SYNC_ACTION_SUPERSEDED", "This action was applied earlier but the binding has since changed; read its current state")
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return ok(prior)
	}
	if !errors.Is(receiptErr, pgx.ErrNoRows) {
		return Result{}, receiptErr
	}
	expected, err := deviceSyncExpectedGeneration(r)
	if err != nil {
		return Result{}, err
	}
	if integer(binding["generation"]) != expected {
		return Result{}, apiError(409, "DEVICE_SYNC_BINDING_STALE", "Binding generation changed; read the current binding before retrying")
	}
	if action != "revoke" {
		if err = lockAndRequireDeviceSyncFamily(ctx, tx, userID, text(binding["family_id"])); err != nil {
			return Result{}, err
		}
	}
	status, consent := text(binding["status"]), text(binding["consent_version"])
	newGeneration := expected
	newStatus := status
	values := Object{}
	switch action {
	case "pause":
		if status == "active" {
			newStatus, newGeneration = "paused", expected+1
		}
		if status != "active" && status != "paused" {
			return Result{}, apiError(409, "DEVICE_SYNC_BINDING_STATE_CONFLICT", "Only an active binding can be paused")
		}
	case "resume":
		if status == "paused" {
			newStatus, newGeneration = "active", expected+1
			consent = text(r.Body["consentVersion"])
			values["consent_version"] = consent
			values["activated_at"] = time.Now().UTC()
		} else if status != "active" {
			return Result{}, apiError(409, "DEVICE_SYNC_BINDING_STATE_CONFLICT", "Only a paused binding can be resumed; revoked bindings require a new binding and import plan")
		}
	case "revoke":
		if status != "revoked" {
			newStatus, newGeneration = "revoked", expected+1
		}
	default:
		return Result{}, apiError(500, "INTERNAL_ERROR", "Unsupported binding action")
	}
	values["status"], values["generation"], values["updated_at"] = newStatus, newGeneration, time.Now().UTC()
	updated, err := updateColumns(ctx, tx, "device_sync_bindings", bindingID, values)
	if err != nil {
		return Result{}, err
	}
	dto := deviceSyncBindingDTO(updated)
	encoded, err := jsonText(dto)
	if err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO device_sync_binding_action_receipts(user_id,binding_id,idempotency_key,request_hash,response_body,created_at)
		VALUES($1,$2,$3,$4,$5::jsonb,NOW())`, userID, bindingID, key, hash, encoded); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(dto)
}

func parseDecimal(value any) int64 {
	parsed, _ := strconv.ParseInt(text(value), 10, 64)
	return parsed
}

func (s *Server) activateDeviceSyncBinding(ctx context.Context, r *Request) (Result, error) {
	bindingID, userID := r.Params["bindingId"], r.Principal.UserID
	key := r.HTTP.Header.Get("Idempotency-Key")
	hash := deviceSyncActionHash("activate", bindingID, r.RawBody)
	importID := text(r.Body["importId"])
	expected, err := syncPosition(text(r.Body["generation"]))
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	binding, err := selectDeviceSyncBinding(ctx, tx, bindingID, userID, "UPDATE")
	if err != nil {
		return Result{}, err
	}
	receipt, receiptErr := one(ctx, tx, `SELECT to_jsonb(a) FROM device_sync_binding_action_receipts a WHERE a.user_id=$1 AND a.binding_id=$2 AND a.idempotency_key=$3`, userID, bindingID, key)
	if receiptErr == nil {
		if strings.TrimSpace(text(receipt["request_hash"])) != hash {
			return Result{}, apiError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different binding action")
		}
		prior := obj(receipt["response_body"])
		if integer(binding["generation"]) != parseDecimal(prior["generation"]) || text(binding["status"]) != text(prior["status"]) {
			return Result{}, apiError(409, "DEVICE_SYNC_ACTION_SUPERSEDED", "Activation was applied earlier but the binding has since changed; read its current state")
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return ok(prior)
	}
	if !errors.Is(receiptErr, pgx.ErrNoRows) {
		return Result{}, receiptErr
	}
	if integer(binding["generation"]) != expected || text(binding["status"]) != "pending" {
		return Result{}, apiError(409, "DEVICE_SYNC_BINDING_STALE", "Only the pending binding generation can be activated")
	}
	if err = lockAndRequireDeviceSyncFamily(ctx, tx, userID, text(binding["family_id"])); err != nil {
		return Result{}, err
	}
	plan, err := one(ctx, tx, `SELECT to_jsonb(p) FROM device_sync_import_plans p WHERE p.id=$1 AND p.binding_id=$2 FOR UPDATE`, importID, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_INCOMPLETE", "Activation requires a server-recorded import plan")
	}
	if err != nil {
		return Result{}, err
	}
	if text(plan["status"]) != "pending" || integer(plan["generation"]) != expected || text(plan["consent_version"]) != text(binding["consent_version"]) {
		return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_INCOMPLETE", "Import plan does not belong to this pending binding generation")
	}
	chunks, err := many(ctx, tx, `SELECT to_jsonb(c) FROM device_sync_import_chunks c WHERE c.import_id=$1 ORDER BY c.chunk_index`, importID)
	if err != nil {
		return Result{}, err
	}
	descriptors := make([]deviceSyncChunkDescriptor, 0, len(chunks))
	var actualRecords int64
	for i, chunk := range chunks {
		if int(integer(chunk["chunk_index"])) != i || text(chunk["status"]) != "applied" {
			return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_INCOMPLETE", "Every approved import chunk must be applied before activation")
		}
		descriptors = append(descriptors, deviceSyncChunkDescriptor{ID: text(chunk["chunk_id"]), Index: i, ItemCount: int(integer(chunk["item_count"])), RequestHash: strings.TrimSpace(text(chunk["request_hash"]))})
		actualRecords += integer(chunk["item_count"])
	}
	if len(chunks) != int(integer(plan["expected_chunk_count"])) || actualRecords != integer(plan["expected_record_count"]) || deviceSyncImportManifestHash(descriptors) != strings.TrimSpace(text(plan["manifest_hash"])) {
		return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_INCOMPLETE", "Recorded chunks do not match the approved manifest")
	}
	newGeneration := expected + 1
	updated, err := updateColumns(ctx, tx, "device_sync_bindings", bindingID, Object{"status": "active", "generation": newGeneration, "activated_at": time.Now().UTC(), "updated_at": time.Now().UTC()})
	if err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE device_sync_import_plans SET status='activated',activated_generation=$2,activated_at=NOW() WHERE id=$1 AND status='pending'`, importID, newGeneration); err != nil {
		return Result{}, err
	}
	dto := deviceSyncBindingDTO(updated)
	encoded, err := jsonText(dto)
	if err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO device_sync_binding_action_receipts(user_id,binding_id,idempotency_key,request_hash,response_body,created_at)
		VALUES($1,$2,$3,$4,$5::jsonb,NOW())`, userID, bindingID, key, hash, encoded); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(dto)
}

func (s *Server) applyDeviceSyncImportChunk(ctx context.Context, r *Request) (Result, error) {
	bindingID, generation, err := deviceSyncCommandGeneration(r)
	if err != nil {
		return Result{}, err
	}
	if bindingID != r.Params["bindingId"] {
		return Result{}, apiError(400, "DEVICE_SYNC_CONTEXT_MISMATCH", "Binding header does not match the requested binding")
	}
	userID, importID := r.Principal.UserID, r.Params["importId"]
	chunkID := text(r.Body["chunkId"])
	commands, validCommands := r.Body["commands"].([]any)
	if !validCommands || len(commands) == 0 || len(commands) > 50 {
		return Result{}, invalid("Import chunk must contain between one and fifty records")
	}
	if sha256Raw(r.RawBody) == "" {
		return Result{}, invalid("Import chunk body is unavailable")
	}
	var raw struct {
		Commands []struct {
			Payload json.RawMessage `json:"payload"`
		} `json:"commands"`
	}
	if err = json.Unmarshal(r.RawBody, &raw); err != nil || len(raw.Commands) != len(commands) {
		return Result{}, invalid("Import chunk body could not be verified")
	}
	requestHash := sha256Raw(r.RawBody)
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	binding, err := validatePendingDeviceSyncBinding(ctx, tx, userID, bindingID, generation)
	if err != nil {
		return Result{}, err
	}
	if err = lockAndRequireDeviceSyncFamily(ctx, tx, userID, text(binding["family_id"])); err != nil {
		return Result{}, err
	}
	plan, err := one(ctx, tx, `SELECT to_jsonb(p) FROM device_sync_import_plans p WHERE p.id=$1 AND p.binding_id=$2 FOR UPDATE`, importID, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "DEVICE_SYNC_IMPORT_PLAN_NOT_FOUND", "Import plan not found")
	}
	if err != nil {
		return Result{}, err
	}
	if text(plan["status"]) != "pending" || integer(plan["generation"]) != generation || text(plan["consent_version"]) != text(binding["consent_version"]) {
		return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_NOT_PENDING", "Import plan does not match the current pending binding generation")
	}
	chunk, err := one(ctx, tx, `SELECT to_jsonb(c) FROM device_sync_import_chunks c WHERE c.import_id=$1 AND c.chunk_id=$2 FOR UPDATE`, importID, chunkID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, apiError(404, "DEVICE_SYNC_IMPORT_CHUNK_NOT_FOUND", "Chunk is not part of the approved import manifest")
	}
	if err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(text(chunk["request_hash"])) != requestHash || int(integer(chunk["item_count"])) != len(commands) {
		return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_CHUNK_MISMATCH", "Chunk bytes or record count do not match the approved manifest")
	}
	if text(chunk["status"]) == "applied" {
		prior := obj(chunk["response_body"])
		if prior == nil {
			return Result{}, apiError(500, "DEVICE_SYNC_IMPORT_RECEIPT_INVALID", "Applied chunk has no stored receipt")
		}
		prior["status"] = "replayed"
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return ok(prior)
	}
	results := make([]Object, 0, len(commands))
	seenCommand, seenEntity := map[string]bool{}, map[string]bool{}
	for i, rawCommand := range commands {
		cmd := obj(rawCommand)
		commandID, entityID := text(cmd["commandId"]), text(cmd["entityId"])
		if commandID == "" || entityID == "" || seenCommand[commandID] || seenEntity[entityID] {
			return Result{}, apiError(422, "DEVICE_SYNC_IMPORT_DUPLICATE_TARGET", "A chunk cannot contain duplicate command IDs or target the same record twice")
		}
		seenCommand[commandID], seenEntity[entityID] = true, true
		if text(cmd["operation"]) != "create" || cmd["baseVersion"] != nil {
			return Result{}, apiError(422, "DEVICE_SYNC_IMPORT_CREATE_ONLY", "Initial import chunks may only create records with a null baseVersion")
		}
		if text(cmd["familyId"]) != text(binding["family_id"]) {
			return Result{}, apiError(403, "DEVICE_SYNC_BINDING_SCOPE_MISMATCH", "Imported records must target the binding family")
		}
		if containsDeviceSyncAttachmentReference(obj(cmd["payload"])) {
			return Result{}, apiError(422, "DEVICE_SYNC_IMPORT_ATTACHMENT_UNSUPPORTED", "Initial import of records with attachments is not supported; no attachment was imported")
		}
		kind := commandKind(text(cmd["entityType"]))
		scope, scopeErr := babyScope(ctx, tx, userID, text(cmd["babyId"]), true)
		if scopeErr != nil {
			return Result{}, scopeErr
		}
		if scope.FamilyID != text(binding["family_id"]) {
			return Result{}, apiError(403, "DEVICE_SYNC_BINDING_SCOPE_MISMATCH", "Imported baby does not belong to the binding family")
		}
		encodedPayload, encodeErr := jsOrderedJSON(raw.Commands[i].Payload)
		if encodeErr != nil {
			return Result{}, encodeErr
		}
		hash, hashErr := orderedHash("operation", "create", "entityType", cmd["entityType"], "id", entityID, "familyId", scope.FamilyID, "babyId", scope.BabyID, "baseVersion", nil, "payload", json.RawMessage(encodedPayload))
		if hashErr != nil {
			return Result{}, hashErr
		}
		digest, hashErr := snapshotHash(cmd)
		if hashErr != nil {
			return Result{}, hashErr
		}
		body := syncPayload(kind, "create", obj(cmd["payload"]), text(cmd["clientCreatedAt"]))
		command, prepErr := s.prepareRecordCommand(r.Principal, scope, kind, entityID, "create", commandID, hash, digest, 1, body, "manual")
		if prepErr != nil {
			return Result{}, prepErr
		}
		command.DeviceSyncBindingID, command.DeviceSyncGeneration = bindingID, generation
		if _, lockErr := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "device-sync-import:"+kind+":"+entityID); lockErr != nil {
			return Result{}, lockErr
		}
		var existingID string
		existsErr := tx.QueryRow(ctx, "SELECT id FROM "+pgx.Identifier{domainRecordTables[kind]}.Sanitize()+" WHERE id=$1 FOR KEY SHARE", entityID).Scan(&existingID)
		if existsErr == nil {
			return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_ID_CONFLICT", "An imported record ID already exists and was left unchanged")
		}
		if !errors.Is(existsErr, pgx.ErrNoRows) {
			return Result{}, existsErr
		}
		outcome, applyErr := s.executeRecordCommandTx(ctx, tx, r, command)
		if applyErr != nil {
			if normalizedError(applyErr).Status == 409 && normalizedError(applyErr).Code == "CONFLICT" {
				return Result{}, apiError(409, "DEVICE_SYNC_IMPORT_ID_CONFLICT", "An imported record ID already exists and was left unchanged")
			}
			return Result{}, applyErr
		}
		results = append(results, Object{"commandId": commandID, "entityId": outcome.Entity["id"], "status": map[bool]string{true: "replayed", false: "applied"}[outcome.Replayed], "version": strconv.FormatInt(outcome.Version, 10), "familyCursor": outcome.Cursor})
	}
	data := Object{"importId": importID, "chunkId": chunkID, "status": "applied", "results": results}
	encoded, err := jsonText(data)
	if err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE device_sync_import_chunks SET status='applied',response_body=$3::jsonb,applied_at=NOW() WHERE import_id=$1 AND chunk_id=$2 AND status='pending'`, importID, chunkID, encoded); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return ok(data)
}

func containsDeviceSyncAttachmentReference(value any) bool {
	switch current := value.(type) {
	case Object:
		for key, item := range current {
			name := strings.ToLower(strings.ReplaceAll(key, "_", ""))
			if name == "attachment" || name == "attachments" || name == "attachmentid" || name == "attachmentids" {
				if deviceSyncAttachmentValuePresent(item) {
					return true
				}
			}
			if containsDeviceSyncAttachmentReference(item) {
				return true
			}
		}
	case map[string]any:
		return containsDeviceSyncAttachmentReference(Object(current))
	case []any:
		for _, item := range current {
			if containsDeviceSyncAttachmentReference(item) {
				return true
			}
		}
	}
	return false
}

func deviceSyncAttachmentValuePresent(value any) bool {
	switch current := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(current) != ""
	case []any:
		for _, item := range current {
			if deviceSyncAttachmentValuePresent(item) {
				return true
			}
		}
		return false
	case []string:
		for _, item := range current {
			if strings.TrimSpace(item) != "" {
				return true
			}
		}
		return false
	case Object:
		return len(current) > 0
	case map[string]any:
		return len(current) > 0
	default:
		return true
	}
}
