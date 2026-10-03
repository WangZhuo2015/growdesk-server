package backend

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const nativeExportMaxBytes = 12 * 1024 * 1024

const nativeExportIdempotencyScope = "native-user-export:"

var nativeExportIdempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func nativeExportIdempotencyKey(values []string) (string, error) {
	if len(values) == 0 {
		return "", nil
	}
	if len(values) != 1 || !nativeExportIdempotencyKeyPattern.MatchString(values[0]) {
		return "", apiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1-128 ASCII letters, digits, dots, underscores, colons, or hyphens")
	}
	return values[0], nil
}

func nativeExportRequestHash(body Object) (string, error) {
	if body == nil {
		body = Object{}
	}
	return snapshotHash(Object{"operation": "user_data_export", "body": body})
}

type nativeExportFamily struct {
	ID                string `json:"id"`
	Epoch             string `json:"epoch"`
	PermissionVersion int64  `json:"permissionVersion"`
}

// Export public projections, never credential rows. Every family is bound to
// its permission epoch at completion and download. PostgreSQL owns the result.
func (s *Server) executeNativeExport(ctx context.Context, lease nativeTaskLease) error {
	input := lease.Input
	if input.FamilyID != "" || input.BabyID != "" {
		return invalid("Account export has an invalid scope")
	}
	families, err := many(ctx, s.DB, `SELECT jsonb_build_object('id',fm.family_id) FROM family_members fm
  JOIN families f ON f.id=fm.family_id AND f.deleted_at IS NULL
  WHERE fm.user_id=$1 AND fm.status='active' AND fm.deleted_at IS NULL ORDER BY fm.family_id LIMIT 33`, input.UserID)
	if err != nil {
		return err
	}
	if len(families) > 32 {
		return apiError(413, "EXPORT_TOO_LARGE", "Account exceeds the export family budget")
	}
	scopes := make([]nativeExportFamily, 0, len(families))
	pages := make([]Object, 0, len(families))
	budget := 0
	for _, family := range families {
		fid := text(family["id"])
		content, e := s.buildNativeSnapshot(ctx, nativeTaskInput{Version: 1, UserID: input.UserID, FamilyID: fid})
		if e != nil {
			return e
		}
		page := Object{"familyId": fid, "epoch": content.Epoch, "highWater": strconv.FormatInt(content.HighWater, 10), "pages": content.Pages}
		raw, e := jsonBytes(page)
		if e != nil {
			return e
		}
		budget += len(raw)
		if budget > nativeExportMaxBytes {
			return apiError(413, "EXPORT_TOO_LARGE", "Account export exceeds its byte budget")
		}
		pages = append(pages, page)
		scopes = append(scopes, nativeExportFamily{ID: fid, Epoch: content.Epoch, PermissionVersion: content.PermissionVersion})
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	// User -> sorted family -> task order also governs account deactivation.
	if err = lockUser(ctx, tx, input.UserID); err != nil {
		return err
	}
	for _, scope := range scopes {
		if _, err = lockFamily(ctx, tx, scope.ID); err != nil {
			return err
		}
	}
	if err = nativeTaskOwner(ctx, tx, input, false); err != nil {
		return err
	}
	if err = validateExportFamilies(ctx, tx, input.UserID, scopes); err != nil {
		return err
	}
	if err = guardNativeLease(ctx, tx, lease); err != nil {
		return err
	}
	user, err := one(ctx, tx, `SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL`, input.UserID)
	if err != nil {
		return err
	}
	payload := Object{"schemaVersion": 1, "user": userDTO(user), "families": pages, "generatedAt": iso(time.Now())}
	normalized, err := toJSONValue(payload)
	if err != nil {
		return err
	}
	raw, err := jsonBytes(normalized)
	if err != nil {
		return err
	}
	if len(raw) > nativeExportMaxBytes {
		return apiError(413, "EXPORT_TOO_LARGE", "Account export exceeds its byte budget")
	}
	digest, err := canonicalNativeHash(normalized)
	if err != nil {
		return err
	}
	result := Object{"schemaVersion": 1, "payload": normalized, "hash": digest, "families": scopes,
		"expiresAt": iso(time.Now().Add(time.Hour)), "downloadPath": "/api/v1/me/exports/" + lease.ID}
	if err = terminalNativeTask(ctx, tx, lease, "succeeded", result); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateExportFamilies(ctx context.Context, q Querier, user string, scopes []nativeExportFamily) error {
	seen := map[string]bool{}
	for _, scope := range scopes {
		if !actionUUID.MatchString(scope.ID) || seen[scope.ID] || scope.Epoch == "" || scope.PermissionVersion < 1 {
			return apiError(409, "EXPORT_INVALID", "Export scope is invalid")
		}
		seen[scope.ID] = true
		if _, err := familyRole(ctx, q, user, scope.ID); err != nil {
			return err
		}
		var epoch string
		var permission int64
		if err := q.QueryRow(ctx, `SELECT epoch,permission_version FROM family_sync_states WHERE family_id=$1`, scope.ID).Scan(&epoch, &permission); err != nil {
			return err
		}
		if epoch != scope.Epoch || permission != scope.PermissionVersion {
			return apiError(410, "EXPORT_SCOPE_CHANGED", "Permissions changed; request a fresh export")
		}
	}
	return nil
}

func (s *Server) exportNativeUserData(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, r.Principal.UserID); err != nil {
		return Result{}, err
	}
	if _, err = liveSession(ctx, tx, r.Principal.UserID, r.Principal.SessionID); err != nil {
		return Result{}, err
	}
	if err = requireRecentSessionReauthentication(ctx, tx, r.Principal.UserID, r.Principal.SessionID); err != nil {
		return Result{}, err
	}
	key, err := nativeExportIdempotencyKey(r.HTTP.Header.Values("Idempotency-Key"))
	if err != nil {
		return Result{}, err
	}
	requestHash := ""
	receiptKey := nativeExportIdempotencyScope + key
	if key != "" {
		requestHash, err = nativeExportRequestHash(r.Body)
		if err != nil {
			return Result{}, err
		}
		receipt, lookupErr := one(ctx, tx, `SELECT to_jsonb(i) FROM idempotency_receipts i
			WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`, r.Principal.UserID, r.Principal.UserID, receiptKey)
		if lookupErr == nil {
			if text(receipt["request_hash"]) != requestHash {
				return Result{}, reusedKey(key)
			}
			response := obj(receipt["response_body"])
			if integer(receipt["result_code"]) != 202 || response == nil ||
				text(response["status"]) != "queued" || !actionUUID.MatchString(text(response["taskId"])) {
				return Result{}, apiError(500, "EXPORT_RECEIPT_INVALID", "Stored export receipt is invalid")
			}
			if err = tx.Commit(ctx); err != nil {
				return Result{}, err
			}
			return Result{Status: 202, Body: envelope(response)}, nil
		}
		if !errors.Is(lookupErr, pgx.ErrNoRows) {
			return Result{}, lookupErr
		}
	}
	if err = nativeTaskOwner(ctx, tx, nativeTaskInput{Version: 1, UserID: r.Principal.UserID}, false); err != nil {
		return Result{}, err
	}
	id := newID()
	if err = enqueueNativeTask(ctx, tx, id, "user_data_export", nativeTaskInput{Version: 1, UserID: r.Principal.UserID}); err != nil {
		return Result{}, err
	}
	response := Object{"taskId": id, "status": "queued"}
	if key != "" {
		body, marshalErr := jsonText(response)
		if marshalErr != nil {
			return Result{}, marshalErr
		}
		if _, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,response_body,completed_at)
			VALUES($1,$2,$3,$4,202,$5::jsonb,NOW())`, r.Principal.UserID, r.Principal.UserID, receiptKey, requestHash, body); err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: 202, Body: envelope(response)}, nil
}

func (s *Server) downloadNativeUserExport(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		row, _, err := s.readOwnedNativeTask(ctx, q, r.Principal.UserID, r.Params["id"])
		if err != nil {
			return Result{}, err
		}
		if text(row["kind"]) != "user_data_export" {
			return Result{}, notFound("Export", r.Params["id"])
		}
		if text(row["status"]) != "succeeded" {
			return Result{}, apiError(409, "EXPORT_NOT_READY", "Export has not completed")
		}
		result := obj(row["result_ref"])
		expires, err := asTime(result["expiresAt"])
		if err != nil || !expires.After(time.Now()) {
			return Result{}, apiError(410, "EXPORT_EXPIRED", "Request a fresh export")
		}
		raw, err := jsonBytes(result["families"])
		if err != nil {
			return Result{}, err
		}
		var scopes []nativeExportFamily
		if err = decodeJSON(raw, &scopes); err != nil || scopes == nil || len(scopes) > 32 {
			return Result{}, apiError(409, "EXPORT_INVALID", "Export metadata is invalid")
		}
		if err = validateExportFamilies(ctx, q, r.Principal.UserID, scopes); err != nil {
			return Result{}, err
		}
		payload := obj(result["payload"])
		if text(obj(payload["user"])["id"]) != r.Principal.UserID {
			return Result{}, apiError(409, "EXPORT_INVALID", "Export owner does not match")
		}
		hash, err := canonicalNativeHash(payload)
		if err != nil {
			return Result{}, err
		}
		if hash != text(result["hash"]) {
			return Result{}, apiError(409, "EXPORT_INVALID", "Export integrity check failed")
		}
		data, err := jsonBytes(payload)
		if err != nil {
			return Result{}, err
		}
		if len(data) > nativeExportMaxBytes {
			return Result{}, errors.New("persisted export exceeds byte budget")
		}
		return ok(payload)
	})
}

func (s *Server) registerNativeExports() {
	s.Register("exportUserData", false, s.exportNativeUserData)
}
