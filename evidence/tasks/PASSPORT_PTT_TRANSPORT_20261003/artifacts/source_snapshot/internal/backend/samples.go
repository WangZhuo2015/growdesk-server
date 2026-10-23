package backend

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerSamples() {
	s.Register("createTimelineEvent", true, s.createTimelineEvent)
	// A sample URL is not a separate trust boundary when it reads real rows.
	s.Register("getGrowthRecord", false, s.getGrowthRecord)
}

func (s *Server) createTimelineEvent(ctx context.Context, r *Request) (Result, error) {
	if r.Body == nil {
		return Result{}, invalid("Missing timeline event payload")
	}
	return ok(r.Body)
}

func (s *Server) getGrowthRecord(ctx context.Context, r *Request) (Result, error) {
	if r.Principal.UserID == "" {
		return Result{}, apiError(401, "UNAUTHORIZED", "Authentication is required")
	}
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		id := r.Params["id"]
		row, err := one(ctx, q, "SELECT to_jsonb(g) FROM growth_measurements g WHERE id=$1 AND deleted_at IS NULL", id)
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, notFound("GrowthRecord", id)
		}
		if err != nil {
			return Result{}, err
		}
		scope, err := babyScope(ctx, q, r.Principal.UserID, text(row["baby_id"]), false)
		if err != nil {
			// Do not expose whether another family's record exists. Preserve
			// operational errors rather than misreporting an outage as absence.
			status := normalizedError(err).Status
			if status == 403 || status == 404 {
				return Result{}, notFound("GrowthRecord", id)
			}
			return Result{}, err
		}
		if scope.FamilyID != text(row["family_id"]) {
			return Result{}, notFound("GrowthRecord", id)
		}
		entity, err := growthEntity(row)
		if err != nil {
			return Result{}, err
		}
		return ok(growthDTO(entity))
	})
}
