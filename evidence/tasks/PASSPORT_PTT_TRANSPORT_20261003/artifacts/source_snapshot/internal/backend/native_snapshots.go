package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerFamilySnapshots() {
	s.Register("createFamilySnapshot", false, s.createNativeFamilySnapshot)
	s.Register("getFamilySnapshot", false, s.getNativeFamilySnapshot)
}
func (s *Server) createNativeFamilySnapshot(ctx context.Context, r *Request) (Result, error) {
	fid := r.Params["id"]
	if _, err := familyRole(ctx, s.DB, r.Principal.UserID, fid); err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, fid)
	if err != nil {
		return Result{}, err
	}
	if _, err = familyRole(ctx, tx, r.Principal.UserID, fid); err != nil {
		return Result{}, err
	}
	state, err := one(ctx, tx, `SELECT to_jsonb(st) FROM family_sync_states st WHERE family_id=$1`, fid)
	if err != nil {
		return Result{}, err
	}
	id := newID()
	manifest, _ := jsonText(Object{"nativeVersion": 1, "userId": r.Principal.UserID, "permissionVersion": state["permission_version"]})
	if _, err = tx.Exec(ctx, `INSERT INTO sync_snapshots(id,scope,scope_id,epoch,high_water,status,page_count,manifest,expires_at,created_at,updated_at)
		VALUES($1,'family',$2,$3,$4,'queued',0,$5::jsonb,NOW()+INTERVAL '24 hours',NOW(),NOW())`, id, fid, state["epoch"], cursor, manifest); err != nil {
		return Result{}, err
	}
	input := nativeTaskInput{Version: 1, UserID: r.Principal.UserID, FamilyID: fid, SnapshotID: id}
	if err = enqueueNativeTask(ctx, tx, id, "sync_snapshot_family", input); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: 202, Body: envelope(Object{"snapshotId": id, "status": "queued"})}, nil
}
func readNativeFamilySnapshot(ctx context.Context, q Querier, user, family, id string) (Object, error) {
	if _, err := familyRole(ctx, q, user, family); err != nil {
		return nil, err
	}
	row, err := one(ctx, q, `SELECT to_jsonb(ss) FROM sync_snapshots ss WHERE id=$1 AND scope='family' AND scope_id=$2`, id, family)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("sync_snapshot", id)
	}
	if err != nil {
		return nil, err
	}
	meta := obj(row["manifest"])
	if meta["nativeVersion"] != nil {
		if text(meta["userId"]) != user {
			return nil, notFound("sync_snapshot", id)
		}
	} else {
		// Retention/deletion may remove the manifest. Ownership survives in the
		// immutable native outbox; never fall back to family-only authorization.
		var owner string
		e := q.QueryRow(ctx, `SELECT o.payload->'__native'->>'userId' FROM task_outbox o WHERE o.aggregate_id=$1 AND o.phase_key='native-initial'`, id).Scan(&owner)
		if e == nil && owner != user {
			return nil, notFound("sync_snapshot", id)
		}
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
	}
	return row, nil
}
func (s *Server) getNativeFamilySnapshot(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		row, err := readNativeFamilySnapshot(ctx, q, r.Principal.UserID, r.Params["id"], r.Params["snapshotId"])
		if err != nil {
			return Result{}, err
		}
		return ok(Object{"id": row["id"], "scope": row["scope"], "epoch": row["epoch"], "highWater": text(row["high_water"]), "status": row["status"], "pageCount": row["page_count"], "expiresAt": isoValue(row["expires_at"])})
	})
}

// Snapshots contain public projections, not database rows with archived
// metadata, credential columns or opaque provider state. The page budget is a
// deliberate refusal boundary, never silent truncation.
type nativeSnapshotPage struct {
	EntityType string   `json:"entityType"`
	Data       []Object `json:"data"`
}
type nativeSnapshotContent struct {
	Epoch                        string
	HighWater, PermissionVersion int64
	Pages                        []nativeSnapshotPage
}

func snapshotRecordDTO(kind string, row Object) (Object, error) {
	switch kind {
	case "growth":
		entity, err := growthEntity(row)
		if err != nil {
			return nil, err
		}
		return growthDTO(entity), nil
	case "medical":
		return medicalReportDTO(row), nil
	case "vaccine":
		return vaccineRecordDTO(row), nil
	}
	d, err := commandSpec(kind)
	if err != nil {
		return nil, err
	}
	if kind == "food" || kind == "supplement" {
		return nutritionRecordDTO(d, nutritionRecordEntity(d, row)), nil
	}
	return careDTO(d, careEntity(d, row)), nil
}
func (s *Server) buildNativeSnapshot(ctx context.Context, input nativeTaskInput) (nativeSnapshotContent, error) {
	var out nativeSnapshotContent
	_, err := s.readSnapshot(ctx, func(q Querier) (Result, error) {
		if err := nativeTaskOwner(ctx, q, input, false); err != nil {
			return Result{}, err
		}
		state, err := one(ctx, q, `SELECT to_jsonb(st) FROM family_sync_states st WHERE family_id=$1`, input.FamilyID)
		if err != nil {
			return Result{}, err
		}
		out.Epoch, out.HighWater, out.PermissionVersion = text(state["epoch"]), integer(state["cursor"]), integer(state["permission_version"])
		babies, err := many(ctx, q, `SELECT to_jsonb(b) FROM babies b JOIN baby_members bm ON bm.baby_id=b.id AND bm.family_id=b.family_id
			WHERE b.family_id=$1 AND bm.user_id=$2 AND bm.status='active' AND bm.deleted_at IS NULL AND b.deleted_at IS NULL
			AND bm.role IN ('admin','member','viewer') ORDER BY b.id LIMIT 201`, input.FamilyID, input.UserID)
		if err != nil {
			return Result{}, err
		}
		if len(babies) > 200 {
			return Result{}, apiError(413, "SNAPSHOT_TOO_LARGE", "Family exceeds snapshot baby budget")
		}
		ids := []string{}
		profiles := []Object{}
		for _, baby := range babies {
			ids = append(ids, text(baby["id"]))
			profiles = append(profiles, babyDTO(baby))
		}
		out.Pages = []nativeSnapshotPage{{EntityType: "baby", Data: profiles}}
		budget, count := 0, 0
		for _, kind := range []string{"feeding", "sleep", "diaper", "food", "supplement", "growth", "medical", "vaccine"} {
			table := domainRecordTables[kind]
			last := ""
			for {
				query := "SELECT to_jsonb(t) FROM "+pgx.Identifier{table}.Sanitize()+" t WHERE family_id=$1 AND baby_id=ANY($2::text[]) AND deleted_at IS NULL AND id>$3 ORDER BY id LIMIT 100"
				if kind == "medical" {
					query = `SELECT to_jsonb(t)||jsonb_build_object('attachment_ids',(SELECT COALESCE(jsonb_agg(attachment_id ORDER BY attachment_id),'[]'::jsonb) FROM medical_report_attachments WHERE report_id=t.id))
					FROM medical_reports t WHERE family_id=$1 AND baby_id=ANY($2::text[]) AND deleted_at IS NULL AND id>$3 ORDER BY id LIMIT 100`
				}
				rows, err := many(ctx, q, query, input.FamilyID, ids, last)
				if err != nil {
					return Result{}, err
				}
				if len(rows) == 0 {
					break
				}
				page := nativeSnapshotPage{EntityType: kind, Data: make([]Object, 0, len(rows))}
				for _, row := range rows {
					value, err := snapshotRecordDTO(kind, row)
					if err != nil {
						return Result{}, err
					}
					page.Data = append(page.Data, value)
					last = text(row["id"])
					count++
				}
				raw, err := jsonBytes(page)
				if err != nil {
					return Result{}, err
				}
				budget += len(raw)
				if count > 20000 || budget > 12*1024*1024 {
					return Result{}, apiError(413, "SNAPSHOT_TOO_LARGE", "Snapshot exceeds the record or byte budget")
				}
				out.Pages = append(out.Pages, page)
			}
		}
		// Shared catalog state is independent of baby record ACLs.
		for _, spec := range []struct {
			kind, table string
			project     func(Object) Object
		}{
			{"formula_product", "formula_products", formulaProductDTO},
			{"supplement_product", "supplement_products", supplementProductDTO},
		} {
			rows, err := many(ctx, q, "SELECT to_jsonb(p) FROM "+pgx.Identifier{spec.table}.Sanitize()+" p WHERE family_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1001", input.FamilyID)
			if err != nil {
				return Result{}, err
			}
			if len(rows) > 1000 {
				return Result{}, apiError(413, "SNAPSHOT_TOO_LARGE", "Catalog exceeds snapshot budget")
			}
			values := make([]Object, 0, len(rows))
			for _, row := range rows {
				values = append(values, spec.project(row))
			}
			out.Pages = append(out.Pages, nativeSnapshotPage{EntityType: spec.kind, Data: values})
		}
		if err := appendNativeSnapshotAuxiliary(ctx, q, input, ids, &out); err != nil {
			return Result{}, err
		}
		return Result{}, nil
	})
	return out, err
}
func (s *Server) getNativeSnapshotPage(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		row, err := readNativeFamilySnapshot(ctx, q, r.Principal.UserID, r.Params["familyId"], r.Params["snapshotId"])
		if err != nil {
			return Result{}, err
		}
		expiry, err := asTime(row["expires_at"])
		if err != nil || !expiry.After(time.Now()) {
			return Result{}, apiError(410, "SNAPSHOT_EXPIRED", "Snapshot has expired")
		}
		if text(row["status"]) != "ready" {
			return Result{}, apiError(409, "SNAPSHOT_NOT_READY", "Snapshot is not ready")
		}
		meta := obj(row["manifest"])
		if integer(meta["nativeVersion"]) != 1 {
			return Result{}, apiError(409, "SNAPSHOT_FORMAT_UNSUPPORTED", "Snapshot cannot be read by this runtime")
		}
		state, err := one(ctx, q, "SELECT to_jsonb(st) FROM family_sync_states st WHERE family_id=$1", r.Params["familyId"])
		if err != nil {
			return Result{}, err
		}
		if text(state["epoch"]) != text(row["epoch"]) || integer(state["permission_version"]) != integer(meta["permissionVersion"]) {
			return Result{}, apiError(410, "SYNC_RESET_REQUIRED", "Snapshot permissions changed; create a new snapshot")
		}
		index, err := strconv.Atoi(r.Params["page"])
		pages, validPages := meta["pages"].([]any)
		if err != nil || !validPages || index < 0 || index >= len(pages) {
			return Result{}, notFound("snapshot_page", r.Params["page"])
		}
		// Guard against accidental/tampered manifests in the database.
		hash, err := snapshotHash(pages)
		if err != nil {
			return Result{}, err
		}
		if hash != strings.TrimSpace(text(row["hash"])) {
			return Result{}, apiError(409, "SNAPSHOT_TAMPERED", "Snapshot integrity check failed")
		}
		return ok(Object{"snapshotId": row["id"], "page": index, "pageCount": len(pages), "highWater": text(row["high_water"]), "content": pages[index]})
	})
}

func toJSONValue(value any) (any, error) {
	raw, err := jsonBytes(value)
	if err != nil {
		return nil, err
	}
	var result any
	err = decodeJSON(raw, &result)
	return result, err
}
func taskResultDTO(row Object) Object {
	attempt := max(int64(1), integer(row["attempt"]))
	return Object{"id": row["id"], "kind": row["kind"], "status": row["status"], "attempt": attempt, "result": row["result_ref"], "error": row["error_details"], "createdAt": isoValue(row["created_at"]), "updatedAt": isoValue(row["updated_at"])}
}
func (s *Server) readOwnedNativeTask(ctx context.Context, q Querier, user, id string) (Object, nativeTaskInput, error) {
	row, err := one(ctx, q, `SELECT to_jsonb(t)||jsonb_build_object('payload',o.payload) FROM task_executions t
		JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
		WHERE t.id=$1 AND t.owner_scope=$2 LIMIT 1`, id, "user:"+user)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nativeTaskInput{}, notFound("Task", id)
	}
	if err != nil {
		return nil, nativeTaskInput{}, err
	}
	input, err := decodeNativeTaskInput(row)
	if err != nil {
		return nil, input, err
	}
	if err = nativeTaskOwner(ctx, q, input, false); err != nil {
		return nil, input, err
	}
	return row, input, nil
}
func (s *Server) getNativeTask(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		row, input, err := s.readOwnedNativeTask(ctx, q, r.Principal.UserID, r.Params["id"])
		if err != nil {
			return Result{}, err
		}
		result := obj(row["result_ref"])
		// Export data is returned only by the separately protected download.
		if input.SnapshotID != "" {
			result = copyObject(result)
			delete(result, "payload")
		}
		if text(row["kind"]) == "user_data_export" {
			result = copyObject(result)
			delete(result, "payload")
		}
		row["result_ref"] = result
		return ok(taskResultDTO(row))
	})
}
func (s *Server) cancelNativeTask(ctx context.Context, r *Request) (Result, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if _, _, err = s.readOwnedNativeTask(ctx, tx, r.Principal.UserID, r.Params["id"]); err != nil {
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

// Ensure typed page slices become ordinary JSON values before canonical hashes
// are computed, so the same hash is obtained after PostgreSQL JSONB decoding.
func nativeSnapshotManifest(input nativeTaskInput, content nativeSnapshotContent) (Object, string, error) {
	pages, err := toJSONValue(content.Pages)
	if err != nil {
		return nil, "", err
	}
	hash, err := snapshotHash(pages)
	if err != nil {
		return nil, "", err
	}
	manifest := Object{"nativeVersion": 1, "userId": input.UserID, "permissionVersion": content.PermissionVersion, "pages": pages}
	raw, err := json.Marshal(manifest)
	if err != nil || len(raw) > 16*1024*1024 {
		return nil, "", apiError(413, "SNAPSHOT_TOO_LARGE", "Snapshot manifest exceeds byte budget")
	}
	return manifest, hash, nil
}
