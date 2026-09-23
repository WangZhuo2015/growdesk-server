package backend

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Domain callbacks own field conversion and business invariants. This boundary
// owns the atomic record/timeline/change/cursor/receipt transaction. Table names
// are a closed internal allowlist, never request fields or route parameters.
var domainRecordTables = map[string]string{
	"food": "food_records", "supplement": "supplement_records",
	"growth": "growth_measurements", "medical": "medical_reports", "vaccine": "vaccine_records",
}

type recordCommand struct {
	Scope Scope
	Kind, ID, Operation, Key, RequestHash, PayloadHash string
	BaseVersion int64
	Apply func(context.Context, pgx.Tx, Object, int64) (recordChange, error)
}

type recordChange struct {
	Entity, Payload Object
	Summary string
	OccurredAt time.Time
}

func (s *Server) executeRecordCommand(ctx context.Context, r *Request, command recordCommand) (result Object, err error) {
	defer func() { err = legacyQueryFailure(err) }()
	table, allowed := domainRecordTables[command.Kind]
	if !allowed || command.Apply == nil || command.Key == "" || command.RequestHash == "" {
		return nil, errors.New("invalid internal record command")
	}
	if command.Operation != "create" && command.Operation != "update" && command.Operation != "delete" && command.Operation != "restore" {
		return nil, errors.New("unsupported internal record operation")
	}
	if _, err := babyScope(ctx, s.DB, r.Principal.UserID, command.Scope.BabyID, true); err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, command.Scope.FamilyID)
	if err != nil {
		return nil, err
	}
	current, err := babyScope(ctx, tx, r.Principal.UserID, command.Scope.BabyID, true)
	if err != nil {
		return nil, err
	}
	if current.FamilyID != command.Scope.FamilyID {
		return nil, apiError(403, "BABY_SCOPE_MISMATCH", "Baby scope changed")
	}
	receipt, err := one(ctx, tx, `SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`, r.Principal.UserID, current.FamilyID, command.Key)
	if err == nil {
		if strings.TrimSpace(text(receipt["request_hash"])) != command.RequestHash {
			return nil, reusedKey(command.Key)
		}
		// Some reference hashes omit explicit null or omit the target scope.
		// A secondary digest on native receipts closes those ambiguities while
		// retaining the reference hash and its ordinary replay interoperability.
		if digest := text(obj(receipt["result_summary"])["nativePayloadHash"]); digest != "" && digest != command.PayloadHash {
			return nil, reusedKey(command.Key)
		}
		entity := obj(receipt["response_body"])
		if entity == nil || text(entity["familyId"]) != current.FamilyID || text(entity["babyId"]) != current.BabyID || (command.Operation != "create" && text(entity["id"]) != command.ID) {
			return nil, reusedKey(command.Key)
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return entity, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	nextVersion := int64(1)
	var existing Object
	if command.Operation != "create" {
		existing, err = one(ctx, tx, "SELECT to_jsonb(t) FROM "+pgx.Identifier{table}.Sanitize()+" t WHERE family_id=$1 AND baby_id=$2 AND id=$3 FOR UPDATE", current.FamilyID, current.BabyID, command.ID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && existing["deleted_at"] != nil && command.Operation != "restore") {
			return nil, notFound(command.Kind, command.ID)
		}
		if err != nil {
			return nil, err
		}
		version := integer(existing["version"])
		if version != command.BaseVersion || version >= math.MaxInt32 {
			return nil, apiError(409, "CONCURRENCY_CONFLICT", fmt.Sprintf("Version conflict on %s:%s", command.Kind, command.ID))
		}
		nextVersion = version + 1
	}
	if cursor == math.MaxInt64 {
		return nil, apiError(409, "CONCURRENCY_CONFLICT", "Family cursor range exhausted")
	}
	change, err := command.Apply(ctx, tx, existing, nextVersion)
	if err != nil {
		return nil, err
	}
	if change.Entity == nil || change.Payload == nil || change.OccurredAt.IsZero() || text(change.Entity["id"]) != command.ID || text(change.Entity["familyId"]) != current.FamilyID || text(change.Entity["babyId"]) != current.BabyID {
		return nil, errors.New("invalid internal domain result")
	}
	if err = publishRecordChange(ctx, tx, r.Principal.UserID, command, change, cursor+1, nextVersion); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return change.Entity, nil
}

func publishRecordChange(ctx context.Context, tx pgx.Tx, userID string, command recordCommand, change recordChange, cursor, version int64) error {
	now := time.Now().UTC()
	details, err := jsonText(change.Payload)
	if err != nil {
		return err
	}
	var deleted any
	op := "upsert"
	if command.Operation == "delete" {
		deleted, op = now, "delete"
	}
	_, err = tx.Exec(ctx, `INSERT INTO timeline_entries(id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,version,deleted_at,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$11)
		ON CONFLICT(family_id,baby_id,entity_type,entity_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,summary=EXCLUDED.summary,
		details=EXCLUDED.details,version=EXCLUDED.version,deleted_at=EXCLUDED.deleted_at,updated_at=EXCLUDED.updated_at`,
		newID(), command.Scope.FamilyID, command.Scope.BabyID, command.Kind, command.ID, change.OccurredAt, change.Summary, details, version, deleted, now)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE family_sync_states SET cursor=$2,updated_at=$3 WHERE family_id=$1`, command.Scope.FamilyID, cursor, now); err != nil {
		return err
	}
	payload := copyObject(change.Payload)
	payload["babyId"] = command.Scope.BabyID
	encoded, err := jsonText(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO family_changes(family_id,cursor,entity_type,entity_id,version,op,payload,schema_version,created_at)
		VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8)`, command.Scope.FamilyID, cursor, command.Kind, command.ID, version, op, encoded, now)
	if err != nil {
		return err
	}
	response, err := jsonText(change.Entity)
	if err != nil {
		return err
	}
	summary := Object{"summary": change.Summary, "familyCursor": strconv.FormatInt(cursor, 10), "version": version}
	if command.PayloadHash != "" {
		summary["nativePayloadHash"] = command.PayloadHash
	}
	summaryJSON, err := jsonText(summary)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,result_summary,response_body,completed_at)
		VALUES($1,$2,$3,$4,200,$5::jsonb,$6::jsonb,$7)`, userID, command.Scope.FamilyID, command.Key, command.RequestHash, summaryJSON, response, now)
	return err
}
