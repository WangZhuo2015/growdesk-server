package backend

import (
	"context"
	"errors"
	"strings"
	"time"
)

func mcpUsageCategory(method, toolName string) string {
	switch method {
	case "tools/list", "resources/list", "resources/read", "prompts/list", "prompts/get":
		return "read"
	case "tools/call":
		if toolName == "create_supplement_product" {
			return "write"
		}
		return "manage"
	default:
		return "manage"
	}
}

func boundedLabel(value string, maxBytes int) string {
	value = strings.TrimSpace(value)
	if len(value) > maxBytes {
		return value[:maxBytes]
	}
	return value
}

func (s *Server) beginMcpUsageCall(ctx context.Context, auth *mcpAuthContext, method, toolName string) (string, error) {
	if auth == nil {
		return "", apiError(401, "UNAUTHORIZED", "A verified MCP grant is required")
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer rollback(tx)
	if err = lockActiveAIUsageOwner(ctx, tx, auth.principal.UserID); err != nil {
		return "", err
	}
	method = boundedLabel(method, 120)
	if method == "" {
		method = "invalid"
	}
	toolName = boundedLabel(toolName, 160)
	var tool any
	if toolName != "" {
		tool = toolName
	}
	id := newID()
	_, err = tx.Exec(ctx, `INSERT INTO native_go.mcp_usage_calls(id,user_id,grant_id,family_id,baby_id,method,tool_name,category,outcome,records_created)
		VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,$8,'pending',CASE WHEN $8='write' THEN NULL ELSE 0 END)`,
		id, auth.principal.UserID, auth.grantID, auth.familyID, auth.babyID, method, tool, mcpUsageCategory(method, toolName))
	if err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func mcpUsageOutcome(result Result, callErr error) (string, string) {
	if callErr != nil {
		var api *APIError
		if errors.As(callErr, &api) {
			return "failed", boundedLabel(api.Code, 80)
		}
		return "failed", "MCP_INTERNAL_ERROR"
	}
	body := obj(result.Body)
	if rpcError := obj(body["error"]); rpcError != nil {
		if integer(rpcError["code"]) == -32003 {
			return "denied", "MCP_RPC_DENIED"
		}
		return "failed", "MCP_RPC_ERROR"
	}
	return "success", ""
}

func mcpResultWasReplay(result Result) bool {
	body := obj(result.Body)
	content := obj(body["result"])["content"]
	var items []any
	switch value := content.(type) {
	case []any:
		items = value
	case []Object:
		items = make([]any, len(value))
		for i := range value {
			items[i] = value[i]
		}
	default:
		return false
	}
	if len(items) == 0 {
		return false
	}
	return strings.Contains(text(obj(items[0])["text"]), `"replayed": true`)
}

func (s *Server) finishMcpUsageCall(ctx context.Context, id, outcome, errorCode string, durationMS int64, result Result) error {
	if outcome != "success" && outcome != "denied" && outcome != "failed" {
		outcome = "failed"
		errorCode = "MCP_INTERNAL_ERROR"
	}
	var errorValue any
	if errorCode != "" {
		errorValue = boundedLabel(errorCode, 80)
	}
	var created any
	if outcome != "success" || mcpResultWasReplay(result) {
		created = int64(0)
	}
	tag, err := s.DB.Exec(ctx, `UPDATE native_go.mcp_usage_calls SET outcome=$2,error_code=$3,
		records_created=COALESCE($4,records_created),completed_at=clock_timestamp(),duration_ms=$5
		WHERE id=$1 AND outcome='pending'`, id, outcome, errorValue, created, max(int64(0), durationMS))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// The account was deleted while the call completed, or a duplicate
		// settlement already recorded this same audit row.
		return nil
	}
	return nil
}

func mcpUsagePeriodStart(now time.Time) time.Time {
	return now.UTC().Truncate(24 * time.Hour)
}
