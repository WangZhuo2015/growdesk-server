import type pg from "pg";
import type { LlmPreferenceSelection } from "@growdesk/contracts";

type Database = Pick<pg.Pool, "query">;

interface LlmPreferenceRow {
  feature: LlmPreferenceSelection["feature"];
  source: LlmPreferenceSelection["source"];
  profile_id: string;
  model_id: string;
}

function selection(row: LlmPreferenceRow): LlmPreferenceSelection {
  return {
    feature: row.feature,
    source: row.source,
    profileId: row.profile_id,
    modelId: row.model_id,
  };
}

/** Stores only per-user catalogue selections; credentials and provider URLs stay server-side. */
export class LlmPreferencesService {
  constructor(private readonly pool: Database) {}

  async list(userId: string): Promise<{ data: { preferences: LlmPreferenceSelection[] } }> {
    const result = await this.pool.query<LlmPreferenceRow>(
      `SELECT feature, source, profile_id, model_id
       FROM llm_preferences
       WHERE user_id = $1
       ORDER BY feature ASC`,
      [userId],
    );
    return { data: { preferences: result.rows.map(selection) } };
  }

  async upsert(
    userId: string,
    value: LlmPreferenceSelection,
  ): Promise<{ data: LlmPreferenceSelection }> {
    const result = await this.pool.query<LlmPreferenceRow>(
      `INSERT INTO llm_preferences (user_id, feature, source, profile_id, model_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, feature) DO UPDATE SET
         source = EXCLUDED.source,
         profile_id = EXCLUDED.profile_id,
         model_id = EXCLUDED.model_id,
         updated_at = CURRENT_TIMESTAMP
       RETURNING feature, source, profile_id, model_id`,
      [userId, value.feature, value.source, value.profileId, value.modelId],
    );
    return { data: selection(result.rows[0]!) };
  }
}
