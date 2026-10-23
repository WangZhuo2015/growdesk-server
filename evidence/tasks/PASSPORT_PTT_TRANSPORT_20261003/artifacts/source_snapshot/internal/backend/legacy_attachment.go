package backend

import (
	"context"
	"strings"
	"unicode/utf8"
)

func nativeLegacyUploadPath(value string) (string, error) {
	if !utf8.ValidString(value) || len(value) > 1024 || !strings.HasPrefix(value, "/uploads/") || strings.ContainsAny(value, "%\\?#") {
		return "", invalid("Invalid legacy attachment path")
	}
	for _, r := range value {
		if r < 32 || r == 127 { return "", invalid("Invalid legacy attachment path") }
	}
	for _, part := range strings.Split(strings.TrimPrefix(value, "/uploads/"), "/") {
		if part == "" || part == "." || part == ".." { return "", invalid("Invalid legacy attachment path") }
	}
	return "public" + value, nil
}

func (s *Server) registerLegacyAttachments() {
	s.Register("resolveLegacyWebAttachment", false, func(ctx context.Context, r *Request) (Result, error) {
		path, err := nativeLegacyUploadPath(r.HTTP.URL.Query().Get("path"))
		if err != nil { return Result{}, err }
		rows, err := many(ctx, s.DB, `SELECT jsonb_build_object('id',id) FROM (
			SELECT DISTINCT a.id
			FROM legacy_idempotency_mappings m
			JOIN attachments a ON a.id=m.metadata->>'attachmentId'
			JOIN families f ON f.id=a.family_id AND f.deleted_at IS NULL
			JOIN users u ON u.id=$1 AND u.deleted_at IS NULL
			JOIN family_members fm ON fm.family_id=a.family_id AND fm.user_id=u.id
				AND fm.status='active' AND fm.deleted_at IS NULL AND fm.role IN ('admin','member','viewer')
			WHERE m.target_entity_type='attachment_reference'
				AND m.mapping_version='attachment-reference-backfill-v1'
				AND m.status='mapped' AND m.metadata->>'storageState'='ready'
				AND m.metadata->>'sourcePath'=$2
				AND a.status='ready' AND a.deleted_at IS NULL
				AND (a.baby_id IS NULL OR EXISTS (
					SELECT 1 FROM baby_members bm JOIN babies b ON b.id=bm.baby_id AND b.family_id=bm.family_id
					WHERE bm.user_id=u.id AND bm.baby_id=a.baby_id AND bm.family_id=a.family_id
						AND bm.status='active' AND bm.deleted_at IS NULL AND b.deleted_at IS NULL
						AND bm.role IN ('admin','member','viewer')))
			ORDER BY a.id LIMIT 2
		) AS authorized`, r.Principal.UserID, path)
		if err != nil { return Result{}, err }
		if len(rows) != 1 || !actionUUID.MatchString(text(rows[0]["id"])) {
			return Result{}, notFound("Attachment", "legacy")
		}
		return ok(Object{"id": rows[0]["id"]})
	})
}
