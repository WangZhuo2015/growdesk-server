package backend

import (
	"context"
	"errors"
	"math"
	"strconv"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerBooks() {
	s.Register("listBooks", false, s.listBooks)
	s.Register("updateBookStatus", false, s.updateBookStatus)
}

func bookDTO(book, state Object, mutation bool) (Object, error) {
	details, err := cloneJSON(book)
	if err != nil {
		return nil, err
	}
	status, version, count, favorite := "unread", "0", int64(0), false
	if state != nil {
		status, version = text(state["status"]), text(state["version"])
		count, favorite = integer(state["read_count"]), boolean(state["is_favorite"])
	}
	category := ""
	if categories, ok := book["categories"].([]any); ok && len(categories) > 0 {
		category = text(categories[0])
	}
	details["isFavorite"], details["readCount"], details["version"] = favorite, count, version
	// The existing wire contract includes this key only in the PATCH response.
	if mutation {
		details["status"] = status
	}
	return Object{"id": book["id"], "title": book["title"], "category": category,
		"status": status, "version": version, "details": details}, nil
}

func (s *Server) listBooks(ctx context.Context, r *Request) (Result, error) {
	catalog, err := loadReferenceCatalogs()
	if err != nil {
		return Result{}, err
	}
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		familyID := r.HTTP.URL.Query().Get("familyId")
		if _, err := familyRole(ctx, q, r.Principal.UserID, familyID); err != nil {
			return Result{}, err
		}
		rows, err := many(ctx, q, `SELECT to_jsonb(s) FROM family_book_statuses s WHERE family_id=$1`, familyID)
		if err != nil {
			return Result{}, err
		}
		states := make(map[string]Object, len(rows))
		for _, row := range rows {
			states[text(row["book_id"])] = row
		}
		result := make([]Object, 0, len(catalog.Books))
		for _, book := range catalog.Books {
			value, err := bookDTO(book, states[text(book["id"])], false)
			if err != nil {
				return Result{}, err
			}
			result = append(result, value)
		}
		return ok(result)
	})
}

func bookPatchState(previous, patch Object) (string, bool, int64, error) {
	status, favorite, count := "unread", false, int64(0)
	if previous != nil {
		status, favorite, count = text(previous["status"]), boolean(previous["is_favorite"]), integer(previous["read_count"])
	}
	if value, present := patch["isFavorite"]; present {
		favorite = boolean(value)
	}
	if value, present := patch["readCount"]; present {
		f := referenceNumeric(value)
		if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > math.MaxInt32 || math.Trunc(f) != f {
			// Do not silently coerce an out-of-range database integer to zero.
			return "", false, 0, errors.New("reading count is outside the database integer range")
		}
		count = int64(f)
		status = "unread"
		if count > 0 {
			status = "finished"
		}
	}
	if value, present := patch["status"]; present {
		status = text(value)
	}
	return status, favorite, count, nil
}

func (s *Server) updateBookStatus(ctx context.Context, r *Request) (Result, error) {
	catalog, err := loadReferenceCatalogs()
	if err != nil {
		return Result{}, err
	}
	bookID := r.Params["id"]
	book := catalog.BooksByID[bookID]
	if book == nil {
		return Result{}, apiError(404, "BOOK_NOT_FOUND", "Book not found")
	}
	_, statusPresent := r.Body["status"]
	_, favoritePresent := r.Body["isFavorite"]
	_, countPresent := r.Body["readCount"]
	if !statusPresent && !favoritePresent && !countPresent {
		return Result{}, apiError(400, "EMPTY_UPDATE", "No reading status supplied")
	}
	familyID := text(r.Body["familyId"])
	if _, err := familyRole(ctx, s.DB, r.Principal.UserID, familyID); err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	cursor, err := lockFamily(ctx, tx, familyID)
	if err != nil {
		return Result{}, err
	}
	role, err := familyRole(ctx, tx, r.Principal.UserID, familyID)
	if err != nil {
		return Result{}, err
	}
	if role == "viewer" {
		return Result{}, apiError(403, "FAMILY_ACCESS_DENIED", "Family write access denied")
	}
	previous, err := one(ctx, tx, `SELECT to_jsonb(s) FROM family_book_statuses s WHERE family_id=$1 AND book_id=$2 FOR UPDATE`, familyID, bookID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	version := integer(previous["version"])
	if value, present := r.Body["baseVersion"]; present {
		n, err := strconv.ParseUint(text(value), 10, 64)
		if err != nil || n != uint64(version) {
			return Result{}, apiError(409, "VERSION_CONFLICT", "Reading status changed; reload before saving")
		}
	}
	if version >= math.MaxInt32 || cursor == math.MaxInt64 {
		return Result{}, apiError(409, "VERSION_CONFLICT", "Reading status version range exhausted")
	}
	status, favorite, count, err := bookPatchState(previous, r.Body)
	if err != nil {
		return Result{}, err
	}
	state, err := one(ctx, tx, `INSERT INTO family_book_statuses AS s
		(id,family_id,book_id,status,is_favorite,read_count,version,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
		ON CONFLICT(family_id,book_id) DO UPDATE SET status=EXCLUDED.status,is_favorite=EXCLUDED.is_favorite,
		read_count=EXCLUDED.read_count,version=s.version+1,updated_at=CURRENT_TIMESTAMP RETURNING to_jsonb(s)`,
		newID(), familyID, bookID, status, favorite, count)
	if err != nil {
		return Result{}, legacyQueryFailure(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE family_sync_states SET cursor=cursor+1,updated_at=CURRENT_TIMESTAMP WHERE family_id=$1`, familyID); err != nil {
		return Result{}, legacyQueryFailure(err)
	}
	payload, err := jsonText(Object{"bookId": bookID, "status": status, "readCount": count, "isFavorite": favorite})
	if err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO family_changes(family_id,cursor,entity_type,entity_id,version,op,payload)
		VALUES($1,$2,'book_status',$3,$4,'upsert',$5::jsonb)`, familyID, cursor+1, text(state["id"]), integer(state["version"]), payload); err != nil {
		return Result{}, legacyQueryFailure(err)
	}
	value, err := bookDTO(book, state, true)
	if err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, legacyQueryFailure(err)
	}
	return ok(Object{"success": true, "book": value})
}
