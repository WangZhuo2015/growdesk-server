package backend

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var attachmentMIMEs = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true, "image/heic": true,
	"audio/m4a": true, "audio/wav": true, "audio/mpeg": true, "audio/mp4": true, "application/pdf": true,
}

func (s *Server) registerAttachments() {
	s.Register("createAttachment", false, s.createNativeAttachment)
	s.Register("completeAttachment", false, s.completeNativeAttachment)
	s.Register("getAttachmentUploadUrl", false, s.renewNativeAttachment)
	s.Register("getAttachmentContent", false, s.getNativeAttachmentContent)
	s.Register("deleteAttachment", false, s.deleteNativeAttachment)
}

func authorizeAttachment(ctx context.Context, q Querier, userID string, row Object, write, uploaderOnly bool) error {
	familyID := text(row["family_id"])
	role, err := familyRole(ctx, q, userID, familyID)
	if err != nil { return err }
	if write && role == "viewer" { return apiError(403, "FAMILY_ACCESS_DENIED", "Family write permission is required") }
	if babyID := text(row["baby_id"]); babyID != "" {
		scope, err := babyScope(ctx, q, userID, babyID, write)
		if err != nil { return err }
		if scope.FamilyID != familyID { return apiError(403, "BABY_SCOPE_MISMATCH", "Attachment scope is inconsistent") }
	}
	if uploaderOnly && text(row["uploader_id"]) != userID {
		return apiError(403, "FAMILY_ACCESS_DENIED", "Only the uploader can complete this upload")
	}
	return nil
}

func attachmentRow(ctx context.Context, q Querier, id string, lock bool) (Object, error) {
	query := "SELECT to_jsonb(a) FROM attachments a WHERE id=$1 AND deleted_at IS NULL"
	if lock { query += " FOR UPDATE" }
	row, err := one(ctx, q, query, id)
	if errors.Is(err, pgx.ErrNoRows) { return nil, notFound("Attachment", id) }
	return row, err
}

func (s *Server) readNativeAttachment(ctx context.Context, userID, id string, write, uploaderOnly bool) (Object, error) {
	var result Object
	_, err := s.readSnapshot(ctx, func(q Querier) (Result, error) {
		row, err := attachmentRow(ctx, q, id, false)
		if err != nil { return Result{}, err }
		if err = authorizeAttachment(ctx, q, userID, row, write, uploaderOnly); err != nil { return Result{}, err }
		result = row
		return Result{}, nil
	})
	return result, err
}

func (s *Server) attachmentMutation(ctx context.Context, r *Request, uploaderOnly bool, apply func(pgx.Tx, Object) (Result, error)) (Result, error) {
	previous, err := s.readNativeAttachment(ctx, r.Principal.UserID, r.Params["id"], true, uploaderOnly)
	if err != nil { return Result{}, err }
	tx, err := s.DB.Begin(ctx)
	if err != nil { return Result{}, err }
	defer rollback(tx)
	if _, err = lockFamily(ctx, tx, text(previous["family_id"])); err != nil { return Result{}, err }
	row, err := attachmentRow(ctx, tx, r.Params["id"], true)
	if err != nil { return Result{}, err }
	if text(row["family_id"]) != text(previous["family_id"]) { return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Attachment scope changed") }
	if err = authorizeAttachment(ctx, tx, r.Principal.UserID, row, true, uploaderOnly); err != nil { return Result{}, err }
	result, err := apply(tx, row)
	if err != nil { return Result{}, err }
	if err = tx.Commit(ctx); err != nil { return Result{}, err }
	return result, nil
}

func attachmentDigest(raw string) (string, error) {
	decoded, err := hex.DecodeString(raw)
	if err != nil || len(decoded) != 32 { return "", invalid("sha256 must be a 64-character hexadecimal digest") }
	return strings.ToLower(raw), nil
}

func (s *Server) createNativeAttachment(ctx context.Context, r *Request) (Result, error) {
	store, err := requireObjectStore(s)
	if err != nil { return Result{}, err }
	mime, size := text(r.Body["mimeType"]), integer(r.Body["byteSize"])
	maximum := int64(20 * 1024 * 1024)
	if strings.HasPrefix(mime, "audio/") { maximum = 25 * 1024 * 1024 }
	if !attachmentMIMEs[mime] || size < 1 || size > maximum { return Result{}, invalid("Unsupported attachment type or size") }
	digest, err := attachmentDigest(text(r.Body["sha256"]))
	if err != nil { return Result{}, err }
	owner := obj(r.Body["ownerScope"])
	familyID, babyID := text(owner["familyId"]), text(owner["babyId"])
	if babyID != "" {
		scope, err := babyScope(ctx, s.DB, r.Principal.UserID, babyID, true)
		if err != nil { return Result{}, err }
		if familyID != "" && familyID != scope.FamilyID { return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Attachment family does not own the baby") }
		familyID = scope.FamilyID
	}
	if familyID == "" {
		familyID, err = foodLibraryFamily(ctx, s.DB, r.Principal.UserID, "")
		if err != nil { return Result{}, err }
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil { return Result{}, err }
	defer rollback(tx)
	if _, err = lockFamily(ctx, tx, familyID); err != nil { return Result{}, err }
	var baby any
	if babyID != "" { baby = babyID }
	metadata := Object{"family_id": familyID, "baby_id": baby, "uploader_id": r.Principal.UserID}
	if err = authorizeAttachment(ctx, tx, r.Principal.UserID, metadata, true, false); err != nil { return Result{}, err }
	id, purpose := newID(), text(r.Body["purpose"])
	key := "families/" + familyID + "/attachments/" + purpose + "/" + time.Now().UTC().Format("2006-01-02") + "/" + id + "." + strings.SplitN(mime, "/", 2)[1]
	upload, err := store.uploadURL(ctx, key, mime, size, 15*time.Minute)
	if err != nil { return Result{}, err }
	expires := time.Now().UTC().Add(15 * time.Minute)
	_, err = tx.Exec(ctx, `INSERT INTO attachments(id,family_id,baby_id,uploader_id,purpose,mime_type,byte_size,sha256,object_key,status,expires_at,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,NOW(),NOW())`, id, familyID, baby, r.Principal.UserID, purpose, mime, size, digest, key, expires)
	if err != nil { return Result{}, err }
	if err = tx.Commit(ctx); err != nil { return Result{}, err }
	return created(Object{"id": id, "uploadUrl": upload, "objectKey": key, "status": "pending", "expiresAt": iso(expires)})
}

func (s *Server) markAttachmentVerificationFailed(ctx context.Context, r *Request) error {
	_, err := s.attachmentMutation(ctx, r, true, func(tx pgx.Tx, row Object) (Result, error) {
		if text(row["status"]) != "ready" {
			if _, err := tx.Exec(ctx, "UPDATE attachments SET status='failed',updated_at=NOW() WHERE id=$1", row["id"]); err != nil { return Result{}, err }
		}
		return ok(Object{"success": true})
	})
	return err
}

func (s *Server) completeNativeAttachment(ctx context.Context, r *Request) (Result, error) {
	store, err := requireObjectStore(s)
	if err != nil { return Result{}, err }
	previous, err := s.readNativeAttachment(ctx, r.Principal.UserID, r.Params["id"], true, true)
	if err != nil { return Result{}, err }
	if text(previous["status"]) == "ready" { return ok(Object{"success": true}) }
	digest, err := attachmentDigest(text(r.Body["sha256"]))
	if err != nil { return Result{}, err }
	if digest != strings.TrimSpace(text(previous["sha256"])) || integer(r.Body["byteSize"]) != integer(previous["byte_size"]) {
		if err := s.markAttachmentVerificationFailed(ctx, r); err != nil { return Result{}, err }
		return Result{}, invalid("Attachment completion metadata does not match the upload")
	}
	release, err := acquireAttachmentIO()
	if err != nil { return Result{}, err }
	defer release()
	file, err := store.verifiedFile(ctx, text(previous["object_key"]), integer(previous["byte_size"]), digest)
	if err != nil {
		if normalizedError(err).Status == 400 {
			if updateErr := s.markAttachmentVerificationFailed(ctx, r); updateErr != nil { return Result{}, updateErr }
		}
		return Result{}, err
	}
	defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
	return s.attachmentMutation(ctx, r, true, func(tx pgx.Tx, row Object) (Result, error) {
		if text(row["status"]) == "ready" { return ok(Object{"success": true}) }
		if text(row["object_key"]) != text(previous["object_key"]) || integer(row["byte_size"]) != integer(previous["byte_size"]) || text(row["sha256"]) != text(previous["sha256"]) {
			return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Upload metadata changed during verification")
		}
		// This key is never granted as a PUT capability. A still-valid upload
		// URL therefore cannot replace bytes already accepted by the API.
		sealed := "families/" + text(row["family_id"]) + "/attachments/sealed/" + text(row["id"]) + "/" + newID()
		if err := store.seal(ctx, sealed, text(row["mime_type"]), integer(row["byte_size"]), digest, file); err != nil { return Result{}, err }
		if _, err := tx.Exec(ctx, "UPDATE attachments SET status='ready',object_key=$2,updated_at=NOW() WHERE id=$1", row["id"], sealed); err != nil {
			// Do not erase an object on an ambiguous transaction outcome. The
			// bounded orphan/staging sweep is a separate worker responsibility.
			return Result{}, err
		}
		return ok(Object{"success": true})
	})
}

func (s *Server) renewNativeAttachment(ctx context.Context, r *Request) (Result, error) {
	store, err := requireObjectStore(s)
	if err != nil { return Result{}, err }
	return s.attachmentMutation(ctx, r, true, func(tx pgx.Tx, row Object) (Result, error) {
		if text(row["status"]) != "pending" { return Result{}, invalid("Only pending uploads can be renewed") }
		upload, err := store.uploadURL(ctx, text(row["object_key"]), text(row["mime_type"]), integer(row["byte_size"]), time.Hour)
		if err != nil { return Result{}, err }
		expires := time.Now().UTC().Add(time.Hour)
		if _, err = tx.Exec(ctx, "UPDATE attachments SET expires_at=$2,updated_at=NOW() WHERE id=$1", row["id"], expires); err != nil { return Result{}, err }
		return ok(Object{"uploadUrl": upload, "expiresAt": iso(expires)})
	})
}

func (s *Server) getNativeAttachmentContent(ctx context.Context, r *Request) (Result, error) {
	row, err := s.readNativeAttachment(ctx, r.Principal.UserID, r.Params["id"], false, false)
	if err != nil { return Result{}, err }
	if text(row["status"]) != "ready" { return Result{}, invalid("Attachment is not ready") }
	store, err := requireObjectStore(s)
	if err != nil { return Result{}, err }
	return Result{Status: 200, Stream: func(w http.ResponseWriter) error {
		release, err := acquireAttachmentIO()
		if err != nil { s.writeError(w, err, r.RequestID); return nil }
		defer release()
		file, err := store.verifiedFile(ctx, text(row["object_key"]), integer(row["byte_size"]), strings.TrimSpace(text(row["sha256"])))
		if err != nil { s.writeError(w, err, r.RequestID); return nil }
		defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
		current, err := s.readNativeAttachment(ctx, r.Principal.UserID, r.Params["id"], false, false)
		if err != nil { s.writeError(w, err, r.RequestID); return nil }
		if text(current["status"]) != "ready" || text(current["object_key"]) != text(row["object_key"]) {
			s.writeError(w, apiError(409, "CONCURRENCY_CONFLICT", "Attachment changed during verification"), r.RequestID)
			return nil
		}
		w.Header().Set("Content-Type", text(row["mime_type"]))
		w.Header().Set("Content-Length", strconv.FormatInt(integer(row["byte_size"]), 10))
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("Cache-Control", "private, no-store")
		w.WriteHeader(200)
		_, err = io.Copy(w, file)
		return err
	}}, nil
}

func (s *Server) deleteNativeAttachment(ctx context.Context, r *Request) (Result, error) {
	store, err := requireObjectStore(s)
	if err != nil { return Result{}, err }
	return s.attachmentMutation(ctx, r, false, func(tx pgx.Tx, row Object) (Result, error) {
		id := text(row["id"])
		var referenced bool
		err := tx.QueryRow(ctx, `SELECT
			EXISTS(SELECT 1 FROM medical_report_attachments WHERE attachment_id=$1) OR
			EXISTS(SELECT 1 FROM babies WHERE deleted_at IS NULL AND avatar_url=$2) OR
			EXISTS(SELECT 1 FROM growth_measurements WHERE attachment_id=$1) OR
			EXISTS(SELECT 1 FROM ai_messages WHERE image=$2) OR
			EXISTS(SELECT 1 FROM ai_archive_entries WHERE attachment_id=$1)`, id, "/api/attachments/"+id).Scan(&referenced)
		if err != nil { return Result{}, err }
		if referenced { return Result{}, apiError(409, "ATTACHMENT_IN_USE", "Attachment is still referenced by family data") }
		if err = store.remove(ctx, text(row["object_key"])); err != nil { return Result{}, err }
		if _, err = tx.Exec(ctx, "UPDATE attachments SET deleted_at=NOW(),status='failed',updated_at=NOW() WHERE id=$1", id); err != nil { return Result{}, err }
		return ok(Object{"success": true})
	})
}
