package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const familyRecordNotificationKind = "family_record_notification"
const familyRecipientBatch = 32
const familyRecipientLimit = 1024
const familyDeviceLimit = 64

// Only committed care events can construct this input. It retains a versioned,
// human-readable snapshot rather than raw record rows, with no actor session/lease.
type familyRecordEvent struct {
	ActorID         string                      `json:"actorId"`
	Kind            string                      `json:"kind"`
	RecordID        string                      `json:"recordId"`
	Operation       string                      `json:"operation"`
	Version         int64                       `json:"version"`
	EventKey        string                      `json:"eventKey"`
	ContentSnapshot *familyNotificationSnapshot `json:"contentSnapshot,omitempty"`
}

func familyRecordKind(kind string) bool {
	switch kind {
	case "feeding", "sleep", "diaper", "food", "supplement", "growth":
		return true
	}
	return false
}

func familyRecordEventKey(input nativeTaskInput) string {
	event := input.FamilyRecord
	if event == nil {
		return ""
	}
	raw := strings.Join([]string{input.FamilyID, input.BabyID, event.Kind, event.RecordID, strconv.FormatInt(event.Version, 10), event.Operation}, "/")
	digest := sha256.Sum256([]byte(raw))
	return "family_record:" + hex.EncodeToString(digest[:])
}

func familyStableID(identity string) string {
	digest := sha256.Sum256([]byte("growdesk-family-notification-v1/" + identity))
	digest[6], digest[8] = digest[6]&0x0f|0x50, digest[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", digest[:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
}

func validFamilyRecordInput(input nativeTaskInput) bool {
	event := input.FamilyRecord
	if input.Version != 1 || event == nil || !actionUUID.MatchString(input.FamilyID) || !actionUUID.MatchString(input.BabyID) || !actionUUID.MatchString(event.ActorID) || !actionUUID.MatchString(event.RecordID) || !familyRecordKind(event.Kind) || event.Version < 1 {
		return false
	}
	if event.ContentSnapshot != nil && !validFamilyNotificationSnapshot(event.ContentSnapshot) {
		return false
	}
	switch event.Operation {
	case "create", "update", "delete", "restore":
	default:
		return false
	}
	return event.EventKey == familyRecordEventKey(input)
}

// Family scope has no dependency on the actor's later membership or account.
func familyRecordScope(ctx context.Context, q Querier, input nativeTaskInput) error {
	if !validFamilyRecordInput(input) || input.UserID != "" {
		return errors.New("invalid family notification scope")
	}
	var active bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM babies b JOIN families f ON f.id=b.family_id
		WHERE b.id=$1 AND b.family_id=$2 AND b.deleted_at IS NULL AND f.deleted_at IS NULL)`, input.BabyID, input.FamilyID).Scan(&active)
	if err != nil {
		return err
	}
	if !active {
		return apiError(403, "BABY_ACCESS_DENIED", "Notification scope is no longer active")
	}
	return nil
}

func nativeLeaseScope(ctx context.Context, q Querier, lease nativeTaskLease) error {
	if lease.Kind == familyRecordNotificationKind {
		return familyRecordScope(ctx, q, lease.Input)
	}
	return nativeTaskOwner(ctx, q, lease.Input, false)
}

// Called only after the domain's receipt replay path, within its existing family
// transaction. No recipient/user lock or external delivery is taken here.
func enqueueFamilyRecordNotification(ctx context.Context, tx pgx.Tx, actor string, scope Scope, kind, record, operation string, version int64) error {
	if !familyRecordKind(kind) {
		return nil
	}
	input := nativeTaskInput{Version: 1, FamilyID: scope.FamilyID, BabyID: scope.BabyID,
		FamilyRecord: &familyRecordEvent{ActorID: actor, Kind: kind, RecordID: record, Operation: operation, Version: version}}
	input.FamilyRecord.EventKey = familyRecordEventKey(input)
	if !validFamilyRecordInput(input) {
		return errors.New("invalid committed family record event")
	}
	snapshot, err := familyNotificationSnapshotFromRecord(ctx, tx, actor, scope, *input.FamilyRecord, true)
	if err != nil {
		return err
	}
	input.FamilyRecord.ContentSnapshot = &snapshot
	if !validFamilyRecordInput(input) {
		return errors.New("invalid committed family notification snapshot")
	}
	return enqueueFamilyTask(ctx, tx, familyStableID("event/"+input.FamilyRecord.EventKey), familyRecordNotificationKind, "family:"+scope.FamilyID, input, time.Now().UTC())
}

func enqueueFamilyTask(ctx context.Context, tx pgx.Tx, id, kind, owner string, input nativeTaskInput, due time.Time) error {
	raw, err := jsonText(Object{"__native": input})
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO task_executions(id,kind,owner_scope,status,attempt,max_attempts,created_at,updated_at)
		VALUES($1,$2,$3,'queued',0,3,NOW(),NOW()) ON CONFLICT(id) DO NOTHING`, id, kind, owner); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_outbox(id,type,aggregate_id,payload_version,payload,phase_key,dispatch_state,next_dispatch_at,created_at)
		VALUES($1,$2,$3,1,$4::jsonb,'native-initial','active',$5,NOW()) ON CONFLICT(id) DO NOTHING`, familyStableID("outbox/"+id), kind, id, raw, due)
	return err
}

func familyNotificationData(input nativeTaskInput) Object {
	event := input.FamilyRecord
	return Object{"eventKind": "family_record", "familyId": input.FamilyID, "babyId": input.BabyID, "actorId": event.ActorID,
		"entityType": event.Kind, "entityId": event.RecordID, "operation": event.Operation,
		"recordVersion": strconv.FormatInt(event.Version, 10), "eventKey": event.EventKey, "url": "/notifications"}
}

// Callers hold UserSyncState before any Family/Task/entity lock. Only public
// notification/preference DTOs are accepted, never a whole device/credential row.
func publishNotificationUserChange(ctx context.Context, tx pgx.Tx, user, kind, id string, version int64, payload Object) error {
	raw, err := jsonText(payload)
	if err != nil {
		return err
	}
	var cursor int64
	if err = tx.QueryRow(ctx, `UPDATE user_sync_states SET cursor=cursor+1,updated_at=NOW()
		WHERE user_id=$1 AND cursor<9223372036854775807 RETURNING cursor`, user).Scan(&cursor); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO user_changes(user_id,cursor,entity_type,entity_id,version,op,payload,schema_version,created_at)
		VALUES($1,$2,$3,$4,$5,'upsert',$6::jsonb,1,NOW())`, user, cursor, kind, id, version, raw)
	return err
}

func (s *Server) executeFamilyRecordNotification(ctx context.Context, lease nativeTaskLease) error {
	if !validFamilyRecordInput(lease.Input) {
		return errors.New("invalid family record notification input")
	}
	if lease.Input.FamilyRecord.ContentSnapshot == nil {
		input := lease.Input
		snapshot, err := familyNotificationSnapshotFromRecord(ctx, s.DB, input.FamilyRecord.ActorID, Scope{FamilyID: input.FamilyID, BabyID: input.BabyID}, *input.FamilyRecord, false)
		if err != nil {
			return err
		}
		input.FamilyRecord.ContentSnapshot = &snapshot
		lease.Input = input
	}
	progress, err := one(ctx, s.DB, `SELECT COALESCE(t.progress,'{}'::jsonb) FROM task_executions t WHERE id=$1`, lease.ID)
	if err != nil {
		return err
	}
	after, count := text(progress["recipientCursor"]), integer(progress["recipientCount"])
	for {
		rows, err := many(ctx, s.DB, `SELECT jsonb_build_object('userId',bm.user_id) FROM baby_members bm
			JOIN family_members fm ON fm.family_id=bm.family_id AND fm.user_id=bm.user_id
			JOIN users u ON u.id=bm.user_id AND u.deleted_at IS NULL
			JOIN babies b ON b.id=bm.baby_id AND b.family_id=bm.family_id AND b.deleted_at IS NULL
			JOIN families f ON f.id=bm.family_id AND f.deleted_at IS NULL
			WHERE bm.baby_id=$1 AND bm.family_id=$2 AND bm.user_id<>$3 AND bm.user_id>$4
			AND bm.status='active' AND bm.deleted_at IS NULL AND bm.role IN ('admin','member','viewer')
			AND fm.status='active' AND fm.deleted_at IS NULL AND fm.role IN ('admin','member','viewer')
			ORDER BY bm.user_id LIMIT $5`, lease.Input.BabyID, lease.Input.FamilyID, lease.Input.FamilyRecord.ActorID, after, familyRecipientBatch)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			if count >= familyRecipientLimit {
				return apiError(413, "NOTIFICATION_FANOUT_LIMIT", "Family notification recipient limit exceeded")
			}
			after, count = text(row["userId"]), count+1
			if err = s.publishFamilyRecipient(ctx, lease, after, count); err != nil {
				return err
			}
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = lockFamily(ctx, tx, lease.Input.FamilyID); err != nil {
		return err
	}
	if err = guardNativeLease(ctx, tx, lease); err != nil {
		return err
	}
	if err = familyRecordScope(ctx, tx, lease.Input); err != nil {
		return err
	}
	finalProgress, err := one(ctx, tx, `SELECT COALESCE(progress,'{}'::jsonb) FROM task_executions WHERE id=$1`, lease.ID)
	if err != nil {
		return err
	}
	result := Object{"eventKey": lease.Input.FamilyRecord.EventKey, "recipientCount": count, "fanoutComplete": true}
	if recipientErrors := obj(finalProgress["recipientErrors"]); len(recipientErrors) > 0 {
		result["recipientErrors"], result["recipientErrorCount"] = recipientErrors, len(recipientErrors)
	}
	if err = terminalNativeTask(ctx, tx, lease, "succeeded", result); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Server) publishFamilyRecipient(ctx context.Context, lease nativeTaskLease, user string, count int64) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Locking the optional row still allows a concurrently deleted user to be
	// skipped after the family/task locks without reversing the global order.
	if _, err = tx.Exec(ctx, `SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE`, user); err != nil {
		return err
	}
	if _, err = lockFamily(ctx, tx, lease.Input.FamilyID); err != nil {
		return err
	}
	if err = guardNativeLease(ctx, tx, lease); err != nil {
		return err
	}
	input := lease.Input
	input.UserID = user
	if user == input.FamilyRecord.ActorID {
		return errors.New("actor cannot receive own family record event")
	}
	eligible := nativeTaskOwner(ctx, tx, input, false)
	if eligible != nil && normalizedError(eligible).Status != 401 && normalizedError(eligible).Status != 403 {
		return eligible
	}
	recipientErrors := Object{}
	if eligible == nil {
		pref, err := readFamilyNotificationPreference(ctx, tx, user, input.BabyID, input.FamilyID)
		if err != nil {
			return err
		}
		if pref.Enabled {
			if err = s.createFamilyRecipientNotification(ctx, tx, input, pref); err != nil {
				var limit *APIError
				if !errors.As(err, &limit) || limit.Code != "NOTIFICATION_DEVICE_LIMIT" {
					return err
				}
				// The inbox/UserChange is already present and no device task has
				// been written. Keep an explicit durable failure for this user,
				// while other eligible family members continue normally.
				recipientErrors[user] = Object{"code": limit.Code, "deviceLimit": familyDeviceLimit,
					"devicesObservedAtLeast": familyDeviceLimit + 1, "delivered": false,
					"notificationId": familyStableID("notification/" + user + "/" + input.FamilyRecord.EventKey)}
			}
		}
	}
	raw, err := jsonText(Object{"recipientCursor": user, "recipientCount": count})
	if err != nil {
		return err
	}
	errorsJSON, err := jsonText(recipientErrors)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE task_executions SET progress=COALESCE(progress,'{}'::jsonb)||$2::jsonb||
		jsonb_build_object('recipientErrors',COALESCE(progress->'recipientErrors','{}'::jsonb)||$3::jsonb),updated_at=NOW()
		WHERE id=$1`, lease.ID, raw, errorsJSON); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Server) createFamilyRecipientNotification(ctx context.Context, tx pgx.Tx, input nativeTaskInput, pref familyNotificationPreference) error {
	if input.FamilyRecord == nil || !validFamilyNotificationSnapshot(input.FamilyRecord.ContentSnapshot) {
		return errors.New("family notification is missing its immutable content snapshot")
	}
	id := familyStableID("notification/" + input.UserID + "/" + input.FamilyRecord.EventKey)
	data, err := jsonText(familyNotificationData(input))
	if err != nil {
		return err
	}
	row, err := one(ctx, tx, `INSERT INTO notifications(id,user_id,event_key,title,body,data,created_at)
		VALUES($1,$2,$3,$4,$5,$6::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET
		title=EXCLUDED.title,body=EXCLUDED.body
		WHERE notifications.title='家庭动态' AND notifications.body='有新的照护记录'
		RETURNING to_jsonb(notifications)`, id, input.UserID, input.FamilyRecord.EventKey,
		input.FamilyRecord.ContentSnapshot.Title, input.FamilyRecord.ContentSnapshot.Body, data)
	if errors.Is(err, pgx.ErrNoRows) {
		// Preserve any already detailed notification. Its delivery outbox rows
		// were committed alongside it, so replay is a no-op.
		return nil
	}
	if err != nil {
		return err
	}
	if err = publishNotificationUserChange(ctx, tx, input.UserID, "notification", id, 1, notificationDTO(row)); err != nil {
		return err
	}
	devices, err := many(ctx, tx, `SELECT to_jsonb(d) FROM push_devices d WHERE user_id=$1 ORDER BY id LIMIT $2`, input.UserID, familyDeviceLimit+1)
	if err != nil {
		return err
	}
	if len(devices) > familyDeviceLimit {
		return apiError(413, "NOTIFICATION_DEVICE_LIMIT", "Notification device limit exceeded")
	}
	due, err := familyQuietEnd(pref, time.Now().UTC())
	if err != nil {
		return err
	}
	if due.IsZero() {
		due = time.Now().UTC()
	}
	for _, device := range devices {
		delivery := input
		delivery.NotificationID, delivery.PushDeviceID = id, text(device["id"])
		if err = enqueueFamilyTask(ctx, tx, familyStableID("delivery/"+id+"/"+delivery.PushDeviceID), "push_delivery", "user:"+input.UserID, delivery, due); err != nil {
			return err
		}
	}
	return nil
}

// Quiet deferral changes dispatch time rather than entering the failure/retry
// path. The delivery's attempt budget is unchanged and other recipients proceed.
func (s *Server) prepareFamilyPush(ctx context.Context, lease nativeTaskLease) (bool, error) {
	input := lease.Input
	if !validFamilyRecordInput(input) || input.UserID == input.FamilyRecord.ActorID {
		return false, errors.New("invalid family push recipient")
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE`, input.UserID); err != nil {
		return false, err
	}
	if _, err = lockFamily(ctx, tx, input.FamilyID); err != nil {
		return false, err
	}
	if err = guardNativeLease(ctx, tx, lease); err != nil {
		return false, err
	}
	allowed := nativeTaskOwner(ctx, tx, input, false)
	if allowed != nil && normalizedError(allowed).Status != 401 && normalizedError(allowed).Status != 403 {
		return false, allowed
	}
	reason := "scope_revoked"
	var due time.Time
	if allowed == nil {
		pref, err := readFamilyNotificationPreference(ctx, tx, input.UserID, input.BabyID, input.FamilyID)
		if err != nil {
			return false, err
		}
		if pref.Enabled {
			due, err = familyQuietEnd(pref, time.Now().UTC())
			if err != nil {
				return false, err
			}
			if due.IsZero() {
				return true, tx.Commit(ctx)
			}
		} else {
			reason = "preferences_disabled"
		}
	}
	if !due.IsZero() {
		if _, err = tx.Exec(ctx, `UPDATE task_executions SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1`, lease.ID); err != nil {
			return false, err
		}
		if _, err = tx.Exec(ctx, `UPDATE task_outbox SET next_dispatch_at=$2,dispatch_state='active' WHERE id=$3 AND aggregate_id=$1 AND phase_key='native-initial'`, lease.ID, due, lease.OutboxID); err != nil {
			return false, err
		}
	} else if err = terminalNativeTask(ctx, tx, lease, "succeeded", Object{"notificationId": input.NotificationID, "delivered": false, "skippedReason": reason}); err != nil {
		return false, err
	}
	return false, tx.Commit(ctx)
}
