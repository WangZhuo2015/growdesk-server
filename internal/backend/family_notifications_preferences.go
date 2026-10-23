package backend

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"time"
	_ "time/tzdata" // The worker must not depend on an OS timezone database.

	"github.com/jackc/pgx/v5"
)

type familyNotificationPreference struct {
	BabyID, TimeZone     string
	Enabled, Quiet       bool
	QuietStart, QuietEnd int
}

var notificationWallTime = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

func notificationTimeZone(zone string) (*time.Location, error) {
	if zone == "" || zone == "Local" || len(zone) > 100 {
		return nil, apiError(400, "INVALID_NOTIFICATION_PREFERENCES", "A valid IANA timeZone is required")
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return nil, apiError(400, "INVALID_NOTIFICATION_PREFERENCES", "A valid IANA timeZone is required")
	}
	return location, nil
}

func notificationWallMinute(value string) (int, error) {
	if !notificationWallTime.MatchString(value) {
		return 0, apiError(400, "INVALID_NOTIFICATION_PREFERENCES", "Quiet hours must use HH:mm")
	}
	hour, _ := strconv.Atoi(value[:2])
	minute, _ := strconv.Atoi(value[3:])
	return hour*60 + minute, nil
}

func notificationWallClock(minute int) string { return fmt.Sprintf("%02d:%02d", minute/60, minute%60) }

func familyPreferenceDTO(pref familyNotificationPreference) Object {
	var baby, quiet any
	if pref.BabyID != "" {
		baby = pref.BabyID
	}
	if pref.Quiet {
		quiet = Object{"start": notificationWallClock(pref.QuietStart), "end": notificationWallClock(pref.QuietEnd)}
	}
	return Object{"babyId": baby, "timeZone": pref.TimeZone, "kinds": Object{"family_record": pref.Enabled}, "quietHours": quiet}
}

func preferenceFromRow(row Object, baby string) (familyNotificationPreference, error) {
	pref := familyNotificationPreference{BabyID: baby, TimeZone: text(row["timezone"])}
	var ok bool
	pref.Enabled, ok = row["family_record_enabled"].(bool)
	if !ok {
		return pref, errors.New("invalid stored notification preference")
	}
	if _, err := notificationTimeZone(pref.TimeZone); err != nil {
		return pref, err
	}
	if row["quiet_start"] != nil || row["quiet_end"] != nil {
		pref.QuietStart, pref.QuietEnd = int(integer(row["quiet_start"])), int(integer(row["quiet_end"]))
		if row["quiet_start"] == nil || row["quiet_end"] == nil || pref.QuietStart < 0 || pref.QuietStart > 1439 || pref.QuietEnd < 0 || pref.QuietEnd > 1439 || pref.QuietStart == pref.QuietEnd {
			return pref, errors.New("invalid stored notification quiet hours")
		}
		pref.Quiet = true
	}
	return pref, nil
}

// Explicit baby settings override the user settings. Without either row, keep
// legacy subscribed-device opt-in behavior and use the current family timezone.
func readFamilyNotificationPreference(ctx context.Context, q Querier, user, baby, family string) (familyNotificationPreference, error) {
	row, err := one(ctx, q, `SELECT to_jsonb(p) FROM notification_preferences p
		WHERE p.user_id=$1 AND (p.scope_key='' OR p.scope_key=$2)
		ORDER BY (p.scope_key=$2) DESC LIMIT 1`, user, baby)
	if err == nil {
		return preferenceFromRow(row, baby)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return familyNotificationPreference{}, err
	}
	pref := familyNotificationPreference{BabyID: baby, Enabled: true, TimeZone: "UTC"}
	if family != "" {
		if err = q.QueryRow(ctx, `SELECT timezone FROM families WHERE id=$1 AND deleted_at IS NULL`, family).Scan(&pref.TimeZone); err != nil {
			return pref, err
		}
	}
	// Older family APIs accepted arbitrary timezone strings. With no explicit
	// quiet window, a bad legacy family zone must not disable an opted-in device.
	// Explicit stored/user-provided preference zones still fail closed above.
	if _, err = notificationTimeZone(pref.TimeZone); err != nil {
		pref.TimeZone = "UTC"
	}
	return pref, nil
}

func familyQuietMinute(pref familyNotificationPreference, instant time.Time) bool {
	minute := instant.Hour()*60 + instant.Minute()
	if pref.QuietStart < pref.QuietEnd {
		return minute >= pref.QuietStart && minute < pref.QuietEnd
	}
	return minute >= pref.QuietStart || minute < pref.QuietEnd
}

func familyQuietEnd(pref familyNotificationPreference, now time.Time) (time.Time, error) {
	location, err := notificationTimeZone(pref.TimeZone)
	if err != nil {
		return time.Time{}, err
	}
	if !pref.Quiet {
		return time.Time{}, nil
	}
	if pref.QuietStart < 0 || pref.QuietStart > 1439 || pref.QuietEnd < 0 || pref.QuietEnd > 1439 || pref.QuietStart == pref.QuietEnd {
		return time.Time{}, errors.New("invalid notification quiet window")
	}
	if !familyQuietMinute(pref, now.In(location)) {
		return time.Time{}, nil
	}
	// Walk actual instants, not time.Date normalization of a missing/repeated
	// local hour. Spring gaps end at the first nonquiet minute; fall folds can
	// quiet a second occurrence independently. The search is explicitly bounded.
	next := now.UTC().Truncate(time.Minute).Add(time.Minute)
	for i := 0; i < 48*60; i++ {
		if !familyQuietMinute(pref, next.In(location)) {
			return next, nil
		}
		next = next.Add(time.Minute)
	}
	return time.Time{}, errors.New("notification quiet window exceeds bounded horizon")
}

func requestFamilyPreference(body Object) (familyNotificationPreference, error) {
	pref := familyNotificationPreference{BabyID: text(body["babyId"]), TimeZone: text(body["timeZone"])}
	if _, err := notificationTimeZone(pref.TimeZone); err != nil {
		return pref, err
	}
	if pref.BabyID != "" && !actionUUID.MatchString(pref.BabyID) {
		return pref, invalid("Invalid notification baby scope")
	}
	var ok bool
	pref.Enabled, ok = obj(body["kinds"])["family_record"].(bool)
	if !ok {
		return pref, invalid("family_record notification preference is required")
	}
	if body["quietHours"] != nil {
		quiet := obj(body["quietHours"])
		var err error
		pref.QuietStart, err = notificationWallMinute(text(quiet["start"]))
		if err != nil {
			return pref, err
		}
		pref.QuietEnd, err = notificationWallMinute(text(quiet["end"]))
		if err != nil {
			return pref, err
		}
		if pref.QuietStart == pref.QuietEnd {
			return pref, apiError(400, "INVALID_NOTIFICATION_PREFERENCES", "Quiet hours start and end must differ")
		}
		pref.Quiet = true
	}
	return pref, nil
}

func (s *Server) getNotificationPreferences(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		baby, family := r.HTTP.URL.Query().Get("babyId"), ""
		if baby != "" {
			scope, err := babyScope(ctx, q, r.Principal.UserID, baby, false)
			if err != nil {
				return Result{}, err
			}
			family = scope.FamilyID
		}
		pref, err := readFamilyNotificationPreference(ctx, q, r.Principal.UserID, baby, family)
		if err != nil {
			return Result{}, err
		}
		return ok(familyPreferenceDTO(pref))
	})
}

func (s *Server) putNotificationPreferences(ctx context.Context, r *Request) (Result, error) {
	pref, err := requestFamilyPreference(r.Body)
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
	if err = nativeTaskOwner(ctx, tx, nativeTaskInput{Version: 1, UserID: r.Principal.UserID}, false); err != nil {
		return Result{}, err
	}
	if pref.BabyID != "" {
		scope, err := babyScope(ctx, tx, r.Principal.UserID, pref.BabyID, false)
		if err != nil {
			return Result{}, err
		}
		if _, err = lockFamily(ctx, tx, scope.FamilyID); err != nil {
			return Result{}, err
		}
		if _, err = babyScope(ctx, tx, r.Principal.UserID, pref.BabyID, false); err != nil {
			return Result{}, err
		}
	}
	existing, err := one(ctx, tx, `SELECT to_jsonb(p) FROM notification_preferences p WHERE user_id=$1 AND scope_key=$2 FOR UPDATE`, r.Principal.UserID, pref.BabyID)
	if err == nil {
		previous, err := preferenceFromRow(existing, pref.BabyID)
		if err != nil {
			return Result{}, err
		}
		if previous == pref {
			return okAfterCommit(tx, ctx, familyPreferenceDTO(pref))
		}
		if integer(existing["version"]) >= math.MaxInt32 {
			return Result{}, apiError(409, "CONCURRENCY_CONFLICT", "Notification preference version exhausted")
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	var baby, start, end any
	if pref.BabyID != "" {
		baby = pref.BabyID
	}
	if pref.Quiet {
		start, end = pref.QuietStart, pref.QuietEnd
	}
	row, err := one(ctx, tx, `INSERT INTO notification_preferences AS p(id,user_id,baby_id,scope_key,timezone,family_record_enabled,quiet_start,quiet_end)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,scope_key) DO UPDATE SET timezone=EXCLUDED.timezone,
		family_record_enabled=EXCLUDED.family_record_enabled,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,
		version=p.version+1,updated_at=NOW() RETURNING to_jsonb(p)`, familyStableID("preference/"+r.Principal.UserID+"/"+pref.BabyID), r.Principal.UserID, baby, pref.BabyID, pref.TimeZone, pref.Enabled, start, end)
	if err != nil {
		return Result{}, err
	}
	if err = publishNotificationUserChange(ctx, tx, r.Principal.UserID, "notification_preferences", text(row["id"]), integer(row["version"]), familyPreferenceDTO(pref)); err != nil {
		return Result{}, err
	}
	return okAfterCommit(tx, ctx, familyPreferenceDTO(pref))
}

func okAfterCommit(tx pgx.Tx, ctx context.Context, body Object) (Result, error) {
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusOK, Body: Object{"data": body}}, nil
}
