package backend

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func mcpUsageToolLabel(method, tool string) string {
	if tool == "create_supplement_product" {
		return "创建补剂产品"
	}
	switch method {
	case "tools/list":
		return "列出 MCP 工具"
	case "initialize":
		return "初始化 MCP 连接"
	case "ping":
		return "MCP 心跳"
	case "tools/call":
		return "调用 MCP 工具"
	default:
		if method != "" {
			return method
		}
		return "未知 MCP 请求"
	}
}

func usageField(row Object, key string) any {
	if row == nil {
		return nil
	}
	return row[key]
}

func mcpConnectionStatus(lastSeen any, totalCalls int64, now time.Time) string {
	if totalCalls == 0 || lastSeen == nil {
		return "authorized"
	}
	seen, err := asTime(lastSeen)
	if err != nil {
		return "authorized"
	}
	if now.Sub(seen) < 7*24*time.Hour {
		return "active"
	}
	return "idle"
}

func (s *Server) personalAIUsage(ctx context.Context, r *Request) (Result, error) {
	babyID := ""
	if r.HTTP != nil {
		babyID = strings.TrimSpace(r.HTTP.URL.Query().Get("babyId"))
	}
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		var baby any
		if babyID != "" {
			scope, err := babyScope(ctx, q, r.Principal.UserID, babyID, false)
			if err != nil {
				status := normalizedError(err).Status
				if status == http.StatusForbidden || status == http.StatusNotFound {
					return Result{}, notFound("Baby", babyID)
				}
				return Result{}, err
			}
			row, err := one(ctx, q, `SELECT to_jsonb(b) FROM babies b WHERE b.id=$1 AND b.family_id=$2 AND b.deleted_at IS NULL`, scope.BabyID, scope.FamilyID)
			if err != nil {
				return Result{}, err
			}
			family, err := one(ctx, q, `SELECT to_jsonb(f) FROM families f WHERE f.id=$1 AND f.deleted_at IS NULL`, scope.FamilyID)
			if err != nil {
				return Result{}, err
			}
			baby = Object{"id": scope.BabyID, "nickname": row["nickname"], "familyId": scope.FamilyID, "familyName": family["name"]}
		}

		overviewRow, err := one(ctx, q, `SELECT to_jsonb(x) FROM (
			SELECT count(*) FILTER (WHERE m.method='tools/call')::bigint AS total_calls,
				count(*) FILTER (WHERE m.method='tools/call' AND m.created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS today_calls,
				count(*) FILTER (WHERE m.method='tools/call' AND m.created_at >= clock_timestamp()-INTERVAL '7 days')::bigint AS last7_days_calls,
				count(*) FILTER (WHERE m.method='tools/call' AND m.category='read')::bigint AS read_calls_count,
				count(*) FILTER (WHERE m.method='tools/call' AND m.category='write')::bigint AS write_calls_count,
				count(*) FILTER (WHERE m.method='tools/call' AND m.category='manage')::bigint AS manage_calls_count,
				CASE WHEN count(*) FILTER (WHERE m.method='tools/call' AND m.outcome IN ('success','denied','failed'))=0 THEN NULL
					ELSE round(100.0*count(*) FILTER (WHERE m.method='tools/call' AND m.outcome='success')/count(*) FILTER (WHERE m.method='tools/call' AND m.outcome IN ('success','denied','failed')),2)::double precision END AS success_rate,
				avg(m.duration_ms) FILTER (WHERE m.method='tools/call' AND m.duration_ms IS NOT NULL)::bigint AS avg_duration_ms,
				CASE WHEN count(*) FILTER (WHERE m.method='tools/call' AND m.category='write' AND m.records_created IS NULL)>0 THEN NULL
					ELSE coalesce(sum(m.records_created) FILTER (WHERE m.method='tools/call'),0)::bigint END AS total_records_created_by_ai
			FROM native_go.mcp_usage_calls m WHERE m.user_id=$1 AND ($2='' OR m.baby_id=$2)
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		agentRows, err := many(ctx, q, `WITH live AS (
			SELECT g.id AS grant_id,g.client_id,COALESCE(c.client_name,'Legacy OAuth client') AS client_name,g.created_at
			FROM native_go.oauth_grants g LEFT JOIN native_go.oauth_clients c ON c.client_id=g.client_id
			WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND ($2='' OR g.baby_id=$2)
		), agent_names AS (
			SELECT client_id,max(client_name) AS client_name,min(created_at) AS first_authorized,max(created_at) AS last_authorized
			FROM live GROUP BY client_id
		), call_stats AS (
			SELECT g.client_id,
				count(m.id) FILTER (WHERE m.method='tools/call')::bigint AS total_calls,
				count(m.id) FILTER (WHERE m.method='tools/call' AND m.created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS today_calls,
				count(m.id) FILTER (WHERE m.method='tools/call' AND m.outcome='success')::bigint AS success_count,
				count(m.id) FILTER (WHERE m.method='tools/call' AND m.outcome IN ('denied','failed'))::bigint AS error_count,
				min(m.created_at) FILTER (WHERE m.method='tools/call') AS first_seen,
				max(m.created_at) FILTER (WHERE m.method='tools/call') AS last_seen,
				CASE WHEN count(m.id) FILTER (WHERE m.method='tools/call' AND m.category='write' AND m.records_created IS NULL)>0 THEN NULL
					ELSE coalesce(sum(m.records_created) FILTER (WHERE m.method='tools/call'),0)::bigint END AS records_written
			FROM native_go.oauth_grants g JOIN native_go.mcp_usage_calls m ON m.grant_id=g.id AND m.user_id=g.user_id
			WHERE g.user_id=$1 AND ($2='' OR m.baby_id=$2) GROUP BY g.client_id
		), ranked_tools AS (
			SELECT g.client_id,m.tool_name,count(*)::bigint AS tool_count,
				row_number() OVER(PARTITION BY g.client_id ORDER BY count(*) DESC,m.tool_name) AS rank
			FROM native_go.oauth_grants g JOIN native_go.mcp_usage_calls m ON m.grant_id=g.id AND m.user_id=g.user_id
			WHERE g.user_id=$1 AND m.method='tools/call' AND m.tool_name IS NOT NULL AND ($2='' OR m.baby_id=$2)
			GROUP BY g.client_id,m.tool_name
		)
		SELECT to_jsonb(x) FROM (
			SELECT n.client_id,n.client_name,coalesce(c.total_calls,0)::bigint AS total_calls,
				coalesce(c.today_calls,0)::bigint AS today_calls,coalesce(c.success_count,0)::bigint AS success_count,
				coalesce(c.error_count,0)::bigint AS error_count,coalesce(c.first_seen,n.first_authorized) AS first_seen,
				coalesce(c.last_seen,n.last_authorized) AS last_seen,c.records_written,t.tool_name AS top_tool,t.tool_count AS top_tool_count
			FROM agent_names n LEFT JOIN call_stats c ON c.client_id=n.client_id
			LEFT JOIN ranked_tools t ON t.client_id=n.client_id AND t.rank=1
			ORDER BY coalesce(c.total_calls,0) DESC,n.client_name,n.client_id LIMIT 100
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		trendRows, err := many(ctx, q, `SELECT to_jsonb(x) FROM (
			SELECT to_char(d.day,'YYYY-MM-DD') AS full_date,to_char(d.day,'MM-DD') AS date,
				count(m.id) FILTER (WHERE m.method='tools/call')::bigint AS total,
				count(m.id) FILTER (WHERE m.method='tools/call' AND m.outcome='success')::bigint AS success,
				count(m.id) FILTER (WHERE m.method='tools/call' AND m.outcome IN ('denied','failed'))::bigint AS error
			FROM generate_series(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '13 days',
				date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC'),INTERVAL '1 day') AS d(day)
			LEFT JOIN native_go.mcp_usage_calls m ON m.user_id=$1 AND m.method='tools/call' AND ($2='' OR m.baby_id=$2)
				AND m.created_at >= (d.day AT TIME ZONE 'UTC') AND m.created_at < ((d.day+INTERVAL '1 day') AT TIME ZONE 'UTC')
			GROUP BY d.day ORDER BY d.day
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		rankingRows, err := many(ctx, q, `SELECT to_jsonb(x) FROM (
			SELECT m.tool_name,m.category,count(*)::bigint AS count,
				round(100.0*count(*)/NULLIF(sum(count(*)) OVER(),0),2)::double precision AS percentage
			FROM native_go.mcp_usage_calls m WHERE m.user_id=$1 AND m.method='tools/call' AND m.tool_name IS NOT NULL AND ($2='' OR m.baby_id=$2)
			GROUP BY m.tool_name,m.category ORDER BY count(*) DESC,m.tool_name LIMIT 10
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		auditRows, err := many(ctx, q, `SELECT to_jsonb(x) FROM (
			SELECT m.id,COALESCE(c.client_name,'Legacy OAuth client') AS agent_name,m.tool_name,
				CASE WHEN m.tool_name IS NULL THEN m.method ELSE m.tool_name END AS tool_label,
				m.method AS action,m.category,m.outcome AS auth_result,m.created_at,m.duration_ms,
				COALESCE(u.display_name,u.username,'家庭成员') AS user_name,COALESCE(fm.relation,fm.role,'家庭成员') AS user_relation,
				NULL::text AS ip,CASE WHEN m.outcome IN ('denied','failed') THEN m.error_code ELSE NULL END AS error_message
			FROM native_go.mcp_usage_calls m JOIN native_go.oauth_grants g ON g.id=m.grant_id
			LEFT JOIN native_go.oauth_clients c ON c.client_id=g.client_id
			JOIN users u ON u.id=m.user_id LEFT JOIN family_members fm ON fm.family_id=m.family_id AND fm.user_id=m.user_id AND fm.deleted_at IS NULL
			WHERE m.user_id=$1 AND ($2='' OR m.baby_id=$2) ORDER BY m.created_at DESC,m.id DESC LIMIT 100
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		runRow, err := one(ctx, q, `SELECT to_jsonb(x) FROM (
			SELECT count(*)::bigint AS total,
				count(*) FILTER (WHERE t.status='queued')::bigint AS queued,
				count(*) FILTER (WHERE t.status IN ('running','cancelling'))::bigint AS running,
				count(*) FILTER (WHERE t.status='succeeded')::bigint AS succeeded,
				count(*) FILTER (WHERE t.status='failed')::bigint AS failed,
				count(*) FILTER (WHERE t.status='cancelled')::bigint AS cancelled
			FROM ai_runs a JOIN task_executions t ON t.id=a.id WHERE a.user_id=$1 AND ($2='' OR a.baby_id=$2)
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		providerRow, err := one(ctx, q, `SELECT to_jsonb(x) FROM (
			SELECT count(*)::bigint AS total_attempts,
				count(*) FILTER (WHERE phase='model')::bigint AS model_calls,
				count(*) FILTER (WHERE phase='asr')::bigint AS asr_calls,
				count(*) FILTER (WHERE status='reported' AND usage_state='reported')::bigint AS reported_attempts,
				count(*) FILTER (WHERE usage_state IN ('unknown','partial') OR status IN ('unknown','dispatched','failed'))::bigint AS unknown_attempts,
				CASE WHEN count(*) FILTER (WHERE phase='model')=0 OR count(*) FILTER (WHERE phase='model' AND input_tokens IS NULL)>0 THEN NULL ELSE sum(input_tokens) FILTER (WHERE phase='model') END AS input_tokens,
				CASE WHEN count(*) FILTER (WHERE phase='model')=0 OR count(*) FILTER (WHERE phase='model' AND output_tokens IS NULL)>0 THEN NULL ELSE sum(output_tokens) FILTER (WHERE phase='model') END AS output_tokens,
				CASE WHEN count(*) FILTER (WHERE phase='model')=0 OR count(*) FILTER (WHERE phase='model' AND total_tokens IS NULL)>0 THEN NULL ELSE sum(total_tokens) FILTER (WHERE phase='model') END AS total_tokens,
				CASE WHEN count(*) FILTER (WHERE phase='model')=0 THEN 'no_calls'
					WHEN count(*) FILTER (WHERE phase='model' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)=count(*) FILTER (WHERE phase='model') THEN 'reported'
					WHEN count(*) FILTER (WHERE phase='model' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL))>0 THEN 'partial' ELSE 'unknown' END AS token_usage_state
			FROM native_go.ai_provider_attempts WHERE user_id=$1 AND ($2='' OR baby_id=$2)
		) x`, r.Principal.UserID, babyID)
		if err != nil {
			return Result{}, err
		}

		now := time.Now().UTC()
		policy, policyErr := nativeAIBudgetPolicy()
		budget := unavailableAIUsageBudget()
		budget["periodStart"] = iso(now.Truncate(24 * time.Hour))
		if policyErr == nil {
			window, windowErr := one(ctx, q, `SELECT to_jsonb(w) FROM native_go.ai_budget_windows w
				WHERE scope_type='user' AND scope_id=$1 AND period_start=$2 AND unit=$3`, r.Principal.UserID, policy.PeriodStart, policy.Unit)
			if windowErr != nil && !errors.Is(windowErr, pgx.ErrNoRows) {
				return Result{}, windowErr
			}
			reserved, settled := int64(0), int64(0)
			if windowErr == nil {
				reserved, settled = integer(window["reserved_units"]), integer(window["settled_units"])
			}
			remaining := policy.UserLimit - reserved - settled
			if remaining < 0 {
				remaining = 0
			}
			budget = Object{"availability": "configured", "unit": policy.Unit, "period": policy.Period,
				"periodStart": iso(policy.PeriodStart), "limit": policy.UserLimit, "reservedUnits": reserved,
				"settledUnits": settled, "remainingUnits": remaining}
		}

		overview := Object{
			"totalCalls": integer(overviewRow["total_calls"]), "todayCalls": integer(overviewRow["today_calls"]),
			"last7DaysCalls": integer(overviewRow["last7_days_calls"]), "connectedAgentsCount": int64(len(agentRows)),
			"successRate": usageField(overviewRow, "success_rate"), "avgDurationMs": usageField(overviewRow, "avg_duration_ms"),
			"readCallsCount": integer(overviewRow["read_calls_count"]), "writeCallsCount": integer(overviewRow["write_calls_count"]),
			"manageCallsCount": integer(overviewRow["manage_calls_count"]), "totalRecordsCreatedByAi": usageField(overviewRow, "total_records_created_by_ai"),
		}
		agents := make([]Object, 0, len(agentRows))
		for _, row := range agentRows {
			clientName := text(row["client_name"])
			totalCalls := integer(row["total_calls"])
			var topTool any
			if tool := text(row["top_tool"]); tool != "" {
				topTool = Object{"toolName": tool, "label": mcpUsageToolLabel("tools/call", tool), "count": integer(row["top_tool_count"])}
			}
			agents = append(agents, Object{"clientId": row["client_id"], "agentName": clientName, "clientName": clientName,
				"status": mcpConnectionStatus(row["last_seen"], totalCalls, now), "totalCalls": totalCalls,
				"todayCalls": integer(row["today_calls"]), "successCount": integer(row["success_count"]), "errorCount": integer(row["error_count"]),
				"firstSeen": isoValue(row["first_seen"]), "lastSeen": isoValue(row["last_seen"]),
				"topTool": topTool, "recordsWritten": usageField(row, "records_written")})
		}
		trend := make([]Object, 0, len(trendRows))
		for _, row := range trendRows {
			trend = append(trend, Object{"date": row["date"], "fullDate": row["full_date"], "total": integer(row["total"]),
				"success": integer(row["success"]), "error": integer(row["error"])})
		}
		ranking := make([]Object, 0, len(rankingRows))
		for _, row := range rankingRows {
			tool := text(row["tool_name"])
			ranking = append(ranking, Object{"toolName": tool, "label": mcpUsageToolLabel("tools/call", tool), "count": integer(row["count"]),
				"percentage": row["percentage"], "category": row["category"]})
		}
		audit := make([]Object, 0, len(auditRows))
		for _, row := range auditRows {
			authResult := text(row["auth_result"])
			if authResult == "failed" {
				authResult = "error"
			}
			audit = append(audit, Object{"id": row["id"], "agentName": row["agent_name"], "toolName": usageField(row, "tool_name"), "toolLabel": row["tool_label"],
				"action": row["action"], "category": row["category"], "authResult": authResult, "createdAt": isoValue(row["created_at"]),
				"durationMs": usageField(row, "duration_ms"), "userName": row["user_name"], "userRelation": row["user_relation"],
				"ip": nil, "errorMessage": usageField(row, "error_message")})
		}
		providerCount := integer(providerRow["total_attempts"])
		costState := "unpriced"
		if providerCount == 0 {
			costState = "no_calls"
		}
		providerUsage := Object{"totalAttempts": providerCount, "modelCalls": integer(providerRow["model_calls"]),
			"asrCalls": integer(providerRow["asr_calls"]), "reportedAttempts": integer(providerRow["reported_attempts"]),
			"unknownAttempts": integer(providerRow["unknown_attempts"]), "inputTokens": usageField(providerRow, "input_tokens"),
			"outputTokens": usageField(providerRow, "output_tokens"), "totalTokens": usageField(providerRow, "total_tokens"),
			"tokenUsageState": providerRow["token_usage_state"], "costMicros": nil, "currency": nil, "costState": costState}
		body := Object{"availability": "partial", "generatedAt": iso(now), "timezone": "UTC", "baby": baby,
			"coverage": Object{"mcpCalls": "native_go_dispatch_only", "providerAttempts": "native_go_attempt_ledger_only",
				"unsupportedMetrics": []string{"legacy_web_mcp_history", "client_ip", "unsupported_legacy_mcp_tools", "provider_cost_without_rate_card"}},
			"overview": overview, "connectedAgents": agents, "toolUsageRanking": ranking, "dailyActivityTrend": trend,
			"recentAuditLogs": audit, "aiRuns": Object{"total": integer(runRow["total"]), "queued": integer(runRow["queued"]),
				"running": integer(runRow["running"]), "succeeded": integer(runRow["succeeded"]), "failed": integer(runRow["failed"]),
				"cancelled": integer(runRow["cancelled"])}, "providerUsage": providerUsage, "budget": budget}
		return Result{Status: http.StatusOK, Body: body}, nil
	})
}
