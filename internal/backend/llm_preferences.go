package backend

import (
	"context"
)

func rejectUnknownLlmPreferenceFields(body Object) error {
	allowed := map[string]struct{}{
		"feature": {}, "source": {}, "profileId": {}, "modelId": {},
	}
	for field := range body {
		if _, ok := allowed[field]; !ok {
			return apiError(400, "INVALID_LLM_PREFERENCE", "Only AI preference selection fields are accepted")
		}
	}
	return nil
}

func (s *Server) registerLlmPreferences() {
	s.Register("getWebAiPreferences", false, s.getLlmPreferences)
	s.Register("upsertWebAiPreference", false, s.upsertLlmPreference)
}

func (s *Server) getLlmPreferences(ctx context.Context, r *Request) (Result, error) {
	rows, err := many(ctx, s.DB, `SELECT jsonb_build_object(
		'feature', feature, 'source', source, 'profileId', profile_id, 'modelId', model_id
	) FROM llm_preferences WHERE user_id=$1 ORDER BY feature ASC`, r.Principal.UserID)
	if err != nil {
		return Result{}, err
	}
	preferences := make([]Object, 0, len(rows))
	preferences = append(preferences, rows...)
	return ok(Object{"preferences": preferences})
}

func (s *Server) upsertLlmPreference(ctx context.Context, r *Request) (Result, error) {
	row, err := one(ctx, s.DB, `INSERT INTO llm_preferences(user_id,feature,source,profile_id,model_id)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(user_id,feature) DO UPDATE SET
			source=EXCLUDED.source,
			profile_id=EXCLUDED.profile_id,
			model_id=EXCLUDED.model_id,
			updated_at=CURRENT_TIMESTAMP
		RETURNING jsonb_build_object(
			'feature',feature,'source',source,'profileId',profile_id,'modelId',model_id
		)`, r.Principal.UserID, text(r.Body["feature"]), text(r.Body["source"]), text(r.Body["profileId"]), text(r.Body["modelId"]))
	if err != nil {
		return Result{}, err
	}
	return ok(row)
}
