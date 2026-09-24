package backend

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerSamples() {
	s.Register("createTimelineEvent", true, s.createTimelineEvent)
	s.Register("getGrowthRecord", true, s.getGrowthRecord)
}

func (s *Server) createTimelineEvent(ctx context.Context, r *Request) (Result, error) {
	if r.Body == nil {
		return Result{}, invalid("Missing timeline event payload")
	}
	return ok(r.Body)
}

func (s *Server) getGrowthRecord(ctx context.Context, r *Request) (Result, error) {
	id := r.Params["id"]
	row, err := one(ctx, s.DB, "SELECT to_jsonb(g) FROM growth_measurements g WHERE id=$1 AND deleted_at IS NULL", id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, notFound("GrowthRecord", id)
		}
		return Result{}, err
	}
	return ok(growthDTO(row))
}
