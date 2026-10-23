package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
)

func (s *Server) registerMcpOAuth() {
	s.Register("getOAuthAuthorizationServerMetadata", true, s.getOAuthAuthorizationServerMetadata)
	s.Register("getOAuthProtectedResourceMetadata", true, s.getOAuthProtectedResourceMetadata)
	s.Register("getOAuthProtectedMcpResourceMetadata", true, s.getOAuthProtectedMcpResourceMetadata)
	s.Register("exchangeMcpOAuthToken", true, s.exchangeMcpOAuthToken)
	s.Register("revokeMcpOAuthToken", true, s.revokeMcpOAuthToken)
	s.Register("handleMcpRpc", true, s.handleMcpRpc)
}

func (s *Server) oauthBaseURL() string {
	return strings.TrimRight(s.Config.PublicURL, "/")
}

func (s *Server) mcpResourceAudience() string {
	if aud := os.Getenv("MCP_RESOURCE_AUDIENCE"); aud != "" {
		return aud
	}
	return s.oauthBaseURL() + "/mcp"
}

func (s *Server) getOAuthAuthorizationServerMetadata(ctx context.Context, r *Request) (Result, error) {
	base := s.oauthBaseURL()
	return Result{Status: 200, Body: Object{
		"issuer":                           base,
		"authorization_endpoint":           base + "/oauth/authorize",
		"token_endpoint":                   base + "/api/v1/mcp/oauth/token",
		"revocation_endpoint":              base + "/api/v1/mcp/oauth/revoke",
		"scopes_supported":                 []string{"mcp:read", "mcp:write"},
		"response_types_supported":         []string{"code"},
		"code_challenge_methods_supported": []string{"S256"},
	}}, nil
}

func (s *Server) getOAuthProtectedResourceMetadata(ctx context.Context, r *Request) (Result, error) {
	base := s.oauthBaseURL()
	return Result{Status: 200, Body: Object{
		"resource":                 base,
		"authorization_servers":    []string{base},
		"scopes_supported":         []string{"mcp:read", "mcp:write"},
		"bearer_methods_supported": []string{"header"},
	}}, nil
}

func (s *Server) getOAuthProtectedMcpResourceMetadata(ctx context.Context, r *Request) (Result, error) {
	base := s.oauthBaseURL()
	return Result{Status: 200, Body: Object{
		"resource":                 s.mcpResourceAudience(),
		"authorization_servers":    []string{base},
		"scopes_supported":         []string{"mcp:read", "mcp:write"},
		"bearer_methods_supported": []string{"header"},
	}}, nil
}

func (s *Server) exchangeMcpOAuthToken(ctx context.Context, r *Request) (Result, error) {
	grantType := text(r.Body["grant_type"])
	clientID := text(r.Body["client_id"])
	if clientID == "" {
		return Result{}, invalid("client_id is required")
	}

	scope := "baby:read baby:write"
	switch grantType {
	case "authorization_code":
		code := text(r.Body["code"])
		if code == "" {
			return Result{}, invalid("code is required for authorization_code grant")
		}
	case "refresh_token":
		refreshToken := text(r.Body["refresh_token"])
		if refreshToken == "" {
			return Result{}, invalid("refresh_token is required for refresh_token grant")
		}
	default:
		return Result{}, apiError(400, "UNSUPPORTED_GRANT_TYPE", "grant_type is not supported")
	}

	// Issue token bound to MCP audience
	now := time.Now().Unix()
	claims := jwt.MapClaims{
		"sub":   "oauth_client_" + clientID,
		"sid":   newID(),
		"aud":   s.mcpResourceAudience(),
		"iss":   "growdesk-api",
		"scope": scope,
		"iat":   now,
		"exp":   now + 3600,
		"jti":   newID(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(s.Config.JWTSecret))
	if err != nil {
		return Result{}, err
	}

	return Result{Status: 200, Body: Object{
		"access_token": token,
		"token_type":   "Bearer",
		"expires_in":   3600,
		"scope":        scope,
	}}, nil
}

func (s *Server) revokeMcpOAuthToken(ctx context.Context, r *Request) (Result, error) {
	return ok(Object{"success": true})
}

type mcpAuthContext struct {
	principal Principal
	claims    jwt.MapClaims
	scopes    map[string]bool
	babyID    string
}

func (s *Server) authenticateMcp(ctx context.Context, r *http.Request) (*mcpAuthContext, error) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, apiError(401, "UNAUTHORIZED", "Missing or malformed Authorization header")
	}
	tokenStr := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if tokenStr == "" {
		return nil, apiError(401, "UNAUTHORIZED", "Missing bearer token")
	}

	claims := jwt.MapClaims{}
	targetAud := s.mcpResourceAudience()
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (any, error) {
		return []byte(s.Config.JWTSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithAudience(targetAud), jwt.WithExpirationRequired())
	if err != nil || !token.Valid {
		return nil, apiError(401, "UNAUTHORIZED", "Invalid or expired MCP access token")
	}

	sub := text(claims["sub"])
	sid := text(claims["sid"])
	if sub == "" {
		return nil, apiError(401, "UNAUTHORIZED", "Invalid token subject")
	}

	p := Principal{UserID: sub, SessionID: sid}
	// If sessionId is present, verify live session
	if sid != "" {
		err = s.DB.QueryRow(ctx, `SELECT u.username, d.device_label FROM device_sessions d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.absolute_expires_at>NOW() AND u.deleted_at IS NULL`, sid, sub).Scan(&p.Username, &p.DeviceLabel)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apiError(401, "SESSION_REVOKED", "Session has expired or was revoked")
		}
		if err != nil {
			return nil, err
		}
	}

	scopes := map[string]bool{}
	for _, sc := range strings.Fields(text(claims["scope"])) {
		scopes[sc] = true
	}

	babyID := text(claims["baby_id"])
	return &mcpAuthContext{
		principal: p,
		claims:    claims,
		scopes:    scopes,
		babyID:    babyID,
	}, nil
}

func rpcError(id any, code int, message string) Result {
	return Result{Status: 200, Body: Object{
		"jsonrpc": "2.0",
		"id":      id,
		"error": Object{
			"code":    code,
			"message": message,
		},
	}}
}

var mcpCreateSupplementTool = Object{
	"name":        "create_supplement_product",
	"description": "在家庭档案库中建档或更新营养补充剂产品，无需打卡即可录入营养成分。",
	"inputSchema": Object{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"name"},
		"properties": Object{
			"name":           Object{"type": "string", "minLength": 1, "maxLength": 200, "description": "补剂全称"},
			"brand":          Object{"type": "string", "maxLength": 100, "description": "品牌名称，默认使用补剂名称"},
			"dosageForm":     Object{"type": "string", "maxLength": 50, "description": "剂型，如 drops、capsule、liquid_ml、sachet、tablet"},
			"unitName":       Object{"type": "string", "maxLength": 50, "description": "单次计量单位，如 滴、粒、ml、袋、片"},
			"defaultDose":    Object{"type": "number", "exclusiveMinimum": 0, "description": "单次推荐用量，默认 1"},
			"nutrients":      Object{"type": "object", "description": "营养成分表，支持数字或 {amount, unit}"},
			"notes":          Object{"type": "string", "description": "补充说明或医嘱注意事项"},
			"familyId":       Object{"type": "string", "description": "可选目标家庭；服务端会与宝宝归属核对"},
			"babyId":         Object{"type": "string", "description": "可选授权锚点；无 grant baby_id 时必填"},
			"idempotencyKey": Object{"type": "string", "maxLength": 128, "description": "可选重试键；缺省使用 JSON-RPC id"},
		},
	},
}

func (s *Server) handleMcpRpc(ctx context.Context, r *Request) (Result, error) {
	auth, err := s.authenticateMcp(ctx, r.HTTP)
	if err != nil {
		return Result{}, err
	}

	rpc := r.Body
	if rpc == nil {
		return Result{}, invalid("Invalid JSON-RPC payload")
	}

	rpcID := rpc["id"]
	method := text(rpc["method"])
	params := obj(rpc["params"])
	if params == nil {
		params = Object{}
	}

	switch method {
	case "initialize":
		return Result{Status: 200, Body: Object{
			"jsonrpc": "2.0",
			"id":      rpcID,
			"result": Object{
				"protocolVersion": "2025-06-18",
				"capabilities":    Object{"tools": Object{}},
				"serverInfo":       Object{"name": "growdesk", "version": "0.1.0"},
			},
		}}, nil

	case "notifications/initialized", "ping":
		return Result{Status: 200, Body: Object{
			"jsonrpc": "2.0",
			"id":      rpcID,
			"result":  Object{},
		}}, nil

	case "tools/list":
		if !auth.scopes["baby:read"] && !auth.scopes["baby:write"] && !auth.scopes["app:read"] && !auth.scopes["app:write"] {
			return rpcError(rpcID, -32003, "Forbidden: missing MCP read scope"), nil
		}
		return Result{Status: 200, Body: Object{
			"jsonrpc": "2.0",
			"id":      rpcID,
			"result": Object{
				"tools": []Object{mcpCreateSupplementTool},
			},
		}}, nil

	case "tools/call":
		toolName := text(params["name"])
		if toolName != "create_supplement_product" {
			return rpcError(rpcID, -32601, "Unknown MCP tool"), nil
		}
		if !auth.scopes["baby:write"] && !auth.scopes["app:write"] {
			return rpcError(rpcID, -32003, "Forbidden: missing baby:write scope"), nil
		}
		args := obj(params["arguments"])
		if args == nil {
			return rpcError(rpcID, -32602, "Tool arguments must be an object"), nil
		}

		requestedBaby := strings.TrimSpace(text(args["babyId"]))
		if auth.babyID != "" && requestedBaby != "" && auth.babyID != requestedBaby {
			return rpcError(rpcID, -32003, "BABY_SCOPE_MISMATCH: token is bound to another baby"), nil
		}
		targetBabyID := auth.babyID
		if targetBabyID == "" {
			targetBabyID = requestedBaby
		}
		if targetBabyID == "" {
			return rpcError(rpcID, -32602, "BABY_SCOPE_REQUIRED: babyId must be provided"), nil
		}

		// Verify baby access and get family ID
		scope, err := babyScope(ctx, s.DB, auth.principal.UserID, targetBabyID, true)
		if err != nil {
			return rpcError(rpcID, -32003, "Access denied to baby"), nil
		}
		if requestedFamily := strings.TrimSpace(text(args["familyId"])); requestedFamily != "" && requestedFamily != scope.FamilyID {
			return rpcError(rpcID, -32003, "BABY_SCOPE_MISMATCH: family does not match baby"), nil
		}

		name := strings.TrimSpace(text(args["name"]))
		if name == "" || len(name) > 200 {
			return rpcError(rpcID, -32602, "name must be between 1 and 200 characters"), nil
		}

		brand := strings.TrimSpace(text(args["brand"]))
		if brand == "" {
			brand = name
		}
		dosageForm := strings.TrimSpace(text(args["dosageForm"]))
		if dosageForm == "" {
			dosageForm = "drops"
		}
		unitName := strings.TrimSpace(text(args["unitName"]))
		if unitName == "" {
			unitName = "滴"
		}

		defaultDose := "1"
		if dVal, exists := args["defaultDose"]; exists {
			switch v := dVal.(type) {
			case float64:
				if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
					return rpcError(rpcID, -32602, "defaultDose must be a positive number"), nil
				}
				defaultDose = strconv.FormatFloat(v, 'f', -1, 64)
			case json.Number:
				num, err := v.Float64()
				if err != nil || num <= 0 {
					return rpcError(rpcID, -32602, "defaultDose must be a positive number"), nil
				}
				defaultDose = v.String()
			case string:
				num, err := strconv.ParseFloat(v, 64)
				if err != nil || num <= 0 {
					return rpcError(rpcID, -32602, "defaultDose must be a positive number"), nil
				}
				defaultDose = v
			}
		}

		notes := strings.TrimSpace(text(args["notes"]))
		nutrients := normalizeMcpNutrients(args["nutrients"])
		nutrientsRaw, err := json.Marshal(nutrients)
		if err != nil {
			return rpcError(rpcID, -32602, "Invalid nutrients payload"), nil
		}

		rawKey := strings.TrimSpace(text(args["idempotencyKey"]))
		if rawKey == "" {
			rawKey = fmt.Sprint(rpcID)
		}
		commandID := "mcp:create_supplement_product:" + rawKey

		// Execute mutation inside transaction
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return Result{}, err
		}
		defer rollback(tx)

		cursor, err := lockMcpMutationScope(ctx, tx, auth, targetBabyID, scope.FamilyID)
		if err != nil {
			status := normalizedError(err).Status
			if status == 403 || status == 404 {
				return rpcError(rpcID, -32003, "Access denied to baby"), nil
			}
			return Result{}, err
		}

		bodyForHash := Object{
			"name":        name,
			"brand":       brand,
			"dosageForm":  dosageForm,
			"unitName":    unitName,
			"defaultDose": defaultDose,
			"nutrients":   nutrients,
			"notes":       notes,
		}
		reqHash := sha256Hex(Object{
			"operation": "create_supplement_product",
			"familyId":  scope.FamilyID,
			"babyId":    targetBabyID,
			"body":      bodyForHash,
		})

		// Check idempotency receipt
		receipt, err := one(ctx, tx, `SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`, auth.principal.UserID, scope.FamilyID, commandID)
		if err == nil {
			if strings.TrimSpace(text(receipt["request_hash"])) != reqHash {
				return rpcError(rpcID, -32602, "Idempotency key reused with different parameters"), nil
			}
			cached := obj(receipt["response_body"])
			textPayload, _ := json.MarshalIndent(Object{
				"success":  true,
				"action":   "create_supplement_product",
				"replayed": true,
				"product":  cached,
			}, "", "  ")
			return Result{Status: 200, Body: Object{
				"jsonrpc": "2.0",
				"id":      rpcID,
				"result": Object{
					"content": []Object{
						{"type": "text", "text": string(textPayload)},
					},
				},
			}}, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return Result{}, err
		}

		// Find existing active product with same name
		existing, err := one(ctx, tx, `SELECT to_jsonb(p) FROM supplement_products p WHERE family_id=$1 AND name=$2 AND deleted_at IS NULL FOR UPDATE`, scope.FamilyID, name)
		now := time.Now().UTC().Truncate(time.Millisecond)
		var productID string
		var version int64 = 1
		if err == nil && existing != nil {
			productID = text(existing["id"])
			version = integer(existing["version"]) + 1
			_, err = tx.Exec(ctx, `UPDATE supplement_products SET brand=$1, dosage_form=$2, unit_name=$3, default_dose=$4, nutrients_json=$5::jsonb, notes=$6, is_active=true, is_archived=false, version=$7, updated_at=$8 WHERE id=$9 AND family_id=$10`,
				brand, dosageForm, unitName, defaultDose, string(nutrientsRaw), notes, version, now, productID, scope.FamilyID)
		} else {
			productID = newID()
			_, err = tx.Exec(ctx, `INSERT INTO supplement_products (id, family_id, name, brand, dosage_form, unit_name, default_dose, nutrients_json, notes, is_active, is_archived, version, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, true, false, 1, $10, $10)`,
				productID, scope.FamilyID, name, brand, dosageForm, unitName, defaultDose, string(nutrientsRaw), notes, now)
		}
		if err != nil {
			return Result{}, err
		}

		// Read back product
		prodRow, err := one(ctx, tx, `SELECT to_jsonb(p) FROM supplement_products p WHERE id=$1 AND family_id=$2`, productID, scope.FamilyID)
		if err != nil {
			return Result{}, err
		}
		product := supplementProductDTO(prodRow)
		product["nutrients"] = nutrients

		cursor++
		if _, err = tx.Exec(ctx, `UPDATE family_sync_states SET cursor=$2, updated_at=$3 WHERE family_id=$1`, scope.FamilyID, cursor, now); err != nil {
			return Result{}, err
		}

		productPayload, _ := json.Marshal(product)
		if _, err = tx.Exec(ctx, `INSERT INTO family_changes (family_id, cursor, entity_type, entity_id, version, op, payload, created_at)
			VALUES ($1, $2, 'supplement_product', $3, $4, 'upsert', $5::jsonb, $6)`,
			scope.FamilyID, cursor, productID, version, string(productPayload), now); err != nil {
			return Result{}, err
		}

		summaryJSON, _ := json.Marshal(Object{"version": version, "familyCursor": strconv.FormatInt(cursor, 10)})
		if _, err = tx.Exec(ctx, `INSERT INTO idempotency_receipts (actor_id, scope_id, command_id, request_hash, result_code, result_summary, response_body, completed_at)
			VALUES ($1, $2, $3, $4, 200, $5::jsonb, $6::jsonb, NOW())`,
			auth.principal.UserID, scope.FamilyID, commandID, reqHash, string(summaryJSON), string(productPayload)); err != nil {
			return Result{}, err
		}

		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}

		textPayload, _ := json.MarshalIndent(Object{
			"success":  true,
			"action":   "create_supplement_product",
			"replayed": false,
			"product":  product,
		}, "", "  ")

		return Result{Status: 200, Body: Object{
			"jsonrpc": "2.0",
			"id":      rpcID,
			"result": Object{
				"content": []Object{
					{"type": "text", "text": string(textPayload)},
				},
			},
		}}, nil

	default:
		return rpcError(rpcID, -32601, "Method not found"), nil
	}
}

func normalizeMcpNutrients(raw any) Object {
	m := obj(raw)
	if m == nil {
		return Object{}
	}
	standardUnits := map[string]string{
		"vitamin_d":   "IU",
		"vitamin_a":   "mcg RAE",
		"vitamin_c":   "mg",
		"calcium":     "mg",
		"iron":        "mg",
		"zinc":        "mg",
		"dha":         "mg",
		"energy_kcal": "kcal",
		"protein":     "g",
	}
	standardKeys := map[string]string{
		"vitamind": "vitamin_d",
		"vitamina": "vitamin_a",
		"vitaminc": "vitamin_c",
	}

	result := Object{}
	for rawKey, rawVal := range m {
		cleanKey := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(rawKey)), "-", "_")
		if cleanKey == "" {
			continue
		}
		key := cleanKey
		if mapped, ok := standardKeys[cleanKey]; ok {
			key = mapped
		}
		unit := standardUnits[key]
		if unit == "" {
			unit = "mg"
		}

		switch v := rawVal.(type) {
		case float64:
			if v >= 0 && !math.IsNaN(v) && !math.IsInf(v, 0) {
				rounded := math.Round(v*100) / 100
				result[key] = Object{"amount": rounded, "unit": unit}
			}
		case json.Number:
			if f, err := v.Float64(); err == nil && f >= 0 && !math.IsNaN(f) && !math.IsInf(f, 0) {
				rounded := math.Round(f*100) / 100
				result[key] = Object{"amount": rounded, "unit": unit}
			}
		case map[string]any:
			subObj := obj(v)
			if subObj == nil {
				continue
			}
			amtVal := subObj["amount"]
			var amount float64 = -1
			switch av := amtVal.(type) {
			case float64:
				amount = av
			case json.Number:
				amount, _ = av.Float64()
			}
			if amount < 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
				continue
			}
			customUnit := strings.TrimSpace(text(subObj["unit"]))
			if customUnit != "" {
				unit = customUnit
			}
			rounded := math.Round(amount*100) / 100
			result[key] = Object{"amount": rounded, "unit": unit}
		}
	}
	return result
}

func sha256Hex(val any) string {
	b, _ := json.Marshal(val)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
