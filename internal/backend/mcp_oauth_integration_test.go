//go:build mcp_oauth_integration

package backend

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type oauthTestResponse struct {
	status int
	header http.Header
	body   []byte
	object map[string]any
}

func oauthHTTPCall(base, method, path, contentType, cookie string, body io.Reader) (oauthTestResponse, error) {
	req, err := http.NewRequest(method, base+path, body)
	if err != nil {
		return oauthTestResponse{}, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return oauthTestResponse{}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return oauthTestResponse{}, err
	}
	result := oauthTestResponse{status: response.StatusCode, header: response.Header.Clone(), body: raw}
	_ = json.Unmarshal(raw, &result.object)
	return result, nil
}

func oauthFormBody(values url.Values) io.Reader { return strings.NewReader(values.Encode()) }

func oauthHidden(t *testing.T, body []byte, name string) string {
	t.Helper()
	pattern := regexp.MustCompile(`name="` + regexp.QuoteMeta(name) + `" value="([^"]+)"`)
	match := pattern.FindSubmatch(body)
	if len(match) != 2 {
		t.Fatalf("OAuth HTML did not contain hidden %s", name)
	}
	return string(match[1])
}

func oauthAuthorize(t *testing.T, base, clientID, redirect, resource, username, password, babyID, cookie string, track func(string)) (string, string, string, string) {
	t.Helper()
	verifier := randomHex(32)
	challengeHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])
	query := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "scope": {"baby:read baby:write"}, "state": {"test-state"}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "resource": {resource}}
	page, err := oauthHTTPCall(base, http.MethodGet, "/oauth/authorize?"+query.Encode(), "", cookie, nil)
	if err != nil {
		t.Fatal(err)
	}
	if page.status != http.StatusOK {
		t.Fatalf("OAuth authorization page status %d: %s", page.status, page.body)
	}
	requestID, secret := oauthHidden(t, page.body, "requestId"), oauthHidden(t, page.body, "browserSecret")
	if track != nil {
		track(requestID)
	}
	if cookie == "" {
		form := url.Values{"requestId": {requestID}, "browserSecret": {secret}, "decision": {"login"}, "username": {username}, "password": {password}}
		login, callErr := oauthHTTPCall(base, http.MethodPost, "/oauth/authorize", "application/x-www-form-urlencoded", "", oauthFormBody(form))
		if callErr != nil {
			t.Fatal(callErr)
		}
		if login.status != http.StatusOK || !strings.Contains(string(login.body), "Authorize ") {
			t.Fatalf("OAuth login did not reach consent: status=%d body=%s", login.status, login.body)
		}
		cookies := login.header.Values("Set-Cookie")
		if len(cookies) != 1 {
			t.Fatalf("OAuth login did not set one browser session cookie: %v", cookies)
		}
		parsed, parseErr := http.ParseSetCookie(cookies[0])
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		cookie = parsed.Name + "=" + parsed.Value
	} else if !strings.Contains(string(page.body), "Authorize ") {
		t.Fatalf("existing OAuth browser session did not reach consent: %s", page.body)
	}
	form := url.Values{"requestId": {requestID}, "browserSecret": {secret}, "scopeSelection": {"true"}, "babyId": {babyID}, "decision": {"allow"}, "scope": {"baby:read", "baby:write"}}
	consent, err := oauthHTTPCall(base, http.MethodPost, "/oauth/authorize", "application/x-www-form-urlencoded", cookie, oauthFormBody(form))
	if err != nil {
		t.Fatal(err)
	}
	if consent.status != http.StatusSeeOther {
		t.Fatalf("OAuth consent did not redirect: status=%d body=%s", consent.status, consent.body)
	}
	location, err := url.Parse(consent.header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Scheme+"://"+location.Host+location.EscapedPath() != redirect || location.Query().Get("state") != "test-state" {
		t.Fatalf("OAuth consent redirect mismatch: %s", location)
	}
	code := location.Query().Get("code")
	if len(code) != 64 {
		t.Fatalf("OAuth authorization code has unexpected length %d", len(code))
	}
	return code, verifier, cookie, requestID
}

func oauthExchange(base, clientID, code, redirect, verifier, resource string) (oauthTestResponse, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code}, "redirect_uri": {redirect}, "code_verifier": {verifier}, "resource": {resource}}
	return oauthHTTPCall(base, http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", "", oauthFormBody(form))
}

func TestMCPOAuthLifecycleHTTPIntegration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	config, err := LoadConfig()
	if err != nil {
		t.Fatalf("load isolated OAuth test config: %v", err)
	}
	server, err := NewServer(ctx, config, nil)
	if err != nil {
		t.Fatalf("open isolated PostgreSQL/Redis runtime: %v", err)
	}
	server.RegisterBusinessHandlers()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	defer server.Close()
	owner := seedPATTenant(t, ctx, server, "oauth_owner")
	foreign := seedPATTenant(t, ctx, server, "oauth_foreign")
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		for _, tenant := range []patTenant{owner, foreign} {
			if tenant.userID != "" {
				if cleanupErr := cleanupPATUser(cleanupCtx, server, tenant); cleanupErr != nil {
					t.Errorf("cleanup test_ OAuth tenant: %v", cleanupErr)
				}
			}
		}
	}()
	password := "test_password_mcp_oauth_42"
	passwordHash, err := server.passwordHash(ctx, password, 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = server.DB.Exec(ctx, `UPDATE users SET password_hash=$1 WHERE id=$2`, passwordHash, owner.userID); err != nil {
		t.Fatal(err)
	}
	trackedRequests := []string{}
	track := func(id string) { trackedRequests = append(trackedRequests, id) }
	clientName := "test MCP OAuth client"
	redirect := "http://127.0.0.1:49173/oauth/callback"
	registration, err := oauthHTTPCall(httpServer.URL, http.MethodPost, "/oauth/register", "application/json", "", strings.NewReader(fmt.Sprintf(`{"client_name":%q,"redirect_uris":[%q]}`, clientName, redirect)))
	if err != nil {
		t.Fatal(err)
	}
	if registration.status != http.StatusCreated {
		t.Fatalf("DCR status %d: %s", registration.status, registration.body)
	}
	clientID := text(registration.object["client_id"])
	defer func() {
		for _, id := range trackedRequests {
			_, _ = server.DB.Exec(context.Background(), `DELETE FROM native_go.oauth_requests WHERE id=$1`, id)
		}
		_, _ = server.DB.Exec(context.Background(), `DELETE FROM native_go.oauth_grants WHERE client_id=$1`, clientID)
		_, _ = server.DB.Exec(context.Background(), `DELETE FROM native_go.oauth_clients WHERE client_id=$1`, clientID)
	}()
	resource := server.mcpResourceAudience()
	for _, bad := range []url.Values{
		{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {"http://127.0.0.1:49174/callback"}, "code_challenge": {"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}, "code_challenge_method": {"S256"}, "resource": {resource}},
		{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "code_challenge": {"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}, "code_challenge_method": {"plain"}, "resource": {resource}},
		{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "code_challenge": {"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}, "code_challenge_method": {"S256"}, "resource": {"https://invalid.example/mcp"}},
	} {
		response, callErr := oauthHTTPCall(httpServer.URL, http.MethodGet, "/oauth/authorize?"+bad.Encode(), "", "", nil)
		if callErr != nil {
			t.Fatal(callErr)
		}
		if response.status != http.StatusBadRequest {
			t.Fatalf("invalid authorize request returned %d", response.status)
		}
	}
	code, verifier, cookie, requestID := oauthAuthorize(t, httpServer.URL, clientID, redirect, resource, owner.username, password, owner.babyID, "", track)
	_ = requestID
	var hashedCode, rawCode bool
	if err = server.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_codes WHERE code_hash=$1)`, hashText(code)).Scan(&hashedCode); err != nil || !hashedCode {
		t.Fatalf("authorization code hash was not persisted: %v", err)
	}
	if err = server.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_codes WHERE code_hash=$1)`, code).Scan(&rawCode); err != nil || rawCode {
		t.Fatalf("raw authorization code was persisted: %v", err)
	}
	var sessionOutlivesGrant bool
	if err = server.DB.QueryRow(ctx, `SELECT d.absolute_expires_at>=g.expires_at FROM native_go.oauth_codes c
		JOIN native_go.oauth_grants g ON g.id=c.grant_id JOIN device_sessions d ON d.id=g.session_id
		WHERE c.code_hash=$1`, hashText(code)).Scan(&sessionOutlivesGrant); err != nil || !sessionOutlivesGrant {
		t.Fatalf("OAuth grant outlives its backing device session: %v", err)
	}
	wrong, err := oauthExchange(httpServer.URL, clientID, code, redirect, strings.Repeat("a", 64), resource)
	if err != nil {
		t.Fatal(err)
	}
	if wrong.status != http.StatusBadRequest {
		t.Fatalf("wrong PKCE verifier status %d", wrong.status)
	}
	wrongAud, err := oauthExchange(httpServer.URL, clientID, code, redirect, verifier, "https://invalid.example/mcp")
	if err != nil {
		t.Fatal(err)
	}
	if wrongAud.status != http.StatusBadRequest {
		t.Fatalf("wrong resource audience status %d", wrongAud.status)
	}
	wrongRedirect, err := oauthExchange(httpServer.URL, clientID, code, "http://127.0.0.1:49174/callback", verifier, resource)
	if err != nil {
		t.Fatal(err)
	}
	if wrongRedirect.status != http.StatusBadRequest {
		t.Fatalf("wrong redirect status %d", wrongRedirect.status)
	}
	type result struct {
		response oauthTestResponse
		err      error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			response, callErr := oauthExchange(httpServer.URL, clientID, code, redirect, verifier, resource)
			results <- result{response, callErr}
		}()
	}
	close(start)
	group.Wait()
	close(results)
	var issued map[string]any
	success, failures := 0, 0
	for value := range results {
		if value.err != nil {
			t.Fatal(value.err)
		}
		if value.response.status == http.StatusOK {
			success++
			issued = value.response.object
		} else if value.response.status == http.StatusBadRequest {
			failures++
		} else {
			t.Fatalf("code exchange status %d: %s", value.response.status, value.response.body)
		}
	}
	if success != 1 || failures != 1 {
		t.Fatalf("authorization code was not atomically single use: success=%d failure=%d", success, failures)
	}
	access, refresh := text(issued["access_token"]), text(issued["refresh_token"])
	if !strings.HasPrefix(access, "mcp_at_") || !strings.HasPrefix(refresh, "mcp_rt_") {
		t.Fatalf("unexpected opaque credential formats")
	}
	var stored bool
	if err = server.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_access WHERE token_hash=$1)`, hashText(access)).Scan(&stored); err != nil || !stored {
		t.Fatalf("access-token hash was not persisted: %v", err)
	}
	var rawStored bool
	if err = server.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_access WHERE token_hash=$1)`, access).Scan(&rawStored); err != nil || rawStored {
		t.Fatalf("raw access token was persisted or hash lookup failed: %v", err)
	}
	var refreshHash, rawRefresh bool
	if err = server.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_refresh WHERE token_hash=$1)`, hashText(refresh)).Scan(&refreshHash); err != nil || !refreshHash {
		t.Fatalf("refresh-token hash was not persisted: %v", err)
	}
	if err = server.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_refresh WHERE token_hash=$1)`, refresh).Scan(&rawRefresh); err != nil || rawRefresh {
		t.Fatalf("raw refresh token was persisted: %v", err)
	}
	oauthAsApp, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me", access, nil)
	if err != nil {
		t.Fatal(err)
	}
	if oauthAsApp.status != http.StatusUnauthorized {
		t.Fatalf("MCP OAuth access was accepted as an app bearer token: %d", oauthAsApp.status)
	}
	appAuth, err := patCall(httpServer.URL, http.MethodPost, "/mcp", owner.accessToken, map[string]any{"jsonrpc": "2.0", "id": "app-session", "method": "tools/list"})
	if err != nil {
		t.Fatal(err)
	}
	if appAuth.status != http.StatusUnauthorized {
		t.Fatalf("app session was accepted as MCP credential: %d", appAuth.status)
	}
	probe := func(token string) patHTTPResponse {
		response, callErr := patCall(httpServer.URL, http.MethodPost, "/mcp", token, map[string]any{"jsonrpc": "2.0", "id": "probe", "method": "tools/list"})
		if callErr != nil {
			t.Fatal(callErr)
		}
		return response
	}
	if result := probe(access); result.status != http.StatusOK {
		t.Fatalf("live OAuth access did not authenticate MCP: %d %#v", result.status, result.body)
	}
	createProduct := func(requestID string) patHTTPResponse {
		response, callErr := patCall(httpServer.URL, http.MethodPost, "/mcp", access, map[string]any{
			"jsonrpc": "2.0", "id": requestID, "method": "tools/call",
			"params": map[string]any{"name": "create_supplement_product", "arguments": map[string]any{
				"babyId": owner.babyID, "familyId": owner.familyID, "name": "test AI usage audit product", "idempotencyKey": "test_ai_usage_audit_product",
			}},
		})
		if callErr != nil {
			t.Fatal(callErr)
		}
		return response
	}
	createdProduct := createProduct("test-create-product")
	if createdProduct.status != http.StatusOK || obj(createdProduct.body["error"]) != nil || mcpResultWasReplay(Result{Body: Object(createdProduct.body)}) {
		t.Fatalf("virtual MCP product creation failed or was unexpectedly replayed: %d %#v", createdProduct.status, createdProduct.body)
	}
	replayedProduct := createProduct("test-create-product-replay")
	if replayedProduct.status != http.StatusOK || !mcpResultWasReplay(Result{Body: Object(replayedProduct.body)}) {
		t.Fatalf("same MCP idempotency key should return the stored product: %d %#v", replayedProduct.status, replayedProduct.body)
	}
	usage, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage?babyId="+owner.babyID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if usage.status != http.StatusOK {
		t.Fatalf("owner AI usage snapshot status %d: %#v", usage.status, usage.body)
	}
	overview := obj(usage.body["overview"])
	if integer(overview["totalCalls"]) != 2 || integer(overview["readCallsCount"]) != 0 || integer(overview["writeCallsCount"]) != 2 || integer(overview["totalRecordsCreatedByAi"]) != 1 {
		t.Fatalf("MCP usage aggregation lost actual calls or replay idempotency: %#v", overview)
	}
	toolRanking, ok := usage.body["toolUsageRanking"].([]any)
	if !ok || len(toolRanking) != 1 || text(obj(toolRanking[0])["toolName"]) != "create_supplement_product" || integer(obj(toolRanking[0])["count"]) != 2 {
		t.Fatalf("MCP tool ranking did not report the supported tool dispatches: %#v", usage.body["toolUsageRanking"])
	}
	agents, ok := usage.body["connectedAgents"].([]any)
	if !ok || len(agents) != 1 || obj(agents[0])["status"] != "active" || integer(obj(agents[0])["successCount"]) != 2 || integer(obj(agents[0])["errorCount"]) != 0 || integer(obj(obj(agents[0])["topTool"])["count"]) != 2 {
		t.Fatalf("MCP connected-agent summary does not match actual successful tool calls: %#v", usage.body["connectedAgents"])
	}
	auditRows, ok := usage.body["recentAuditLogs"].([]any)
	if !ok || len(auditRows) != 3 {
		t.Fatalf("MCP recent call audit did not retain the three authenticated dispatches: %#v", usage.body["recentAuditLogs"])
	}
	if obj(auditRows[0])["action"] == nil || obj(auditRows[0])["authResult"] != "success" {
		t.Fatalf("MCP audit rows do not retain dashboard-compatible action and outcome fields: %#v", auditRows[0])
	}
	dailyTrend, ok := usage.body["dailyActivityTrend"].([]any)
	if !ok || len(dailyTrend) != 14 || integer(obj(dailyTrend[len(dailyTrend)-1])["total"]) != 2 || integer(obj(dailyTrend[len(dailyTrend)-1])["success"]) != 2 {
		t.Fatalf("MCP daily trend must count tool calls and expose successful outcomes: %#v", usage.body["dailyActivityTrend"])
	}
	var callCount, createdCount, unfinishedCount int
	if err = server.DB.QueryRow(ctx, `SELECT count(*),COALESCE(sum(records_created),0),count(*) FILTER (WHERE outcome='pending') FROM native_go.mcp_usage_calls WHERE user_id=$1 AND baby_id=$2`, owner.userID, owner.babyID).Scan(&callCount, &createdCount, &unfinishedCount); err != nil {
		t.Fatalf("read persisted MCP audit rows: %v", err)
	}
	if callCount != 3 || createdCount != 1 || unfinishedCount != 0 {
		t.Fatalf("MCP audit rows must settle once and count one newly-created product: calls=%d created=%d pending=%d", callCount, createdCount, unfinishedCount)
	}
	foreignUsage, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage", foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if foreignUsage.status != http.StatusOK || integer(obj(foreignUsage.body["overview"])["totalCalls"]) != 0 || len(foreignUsage.body["recentAuditLogs"].([]any)) != 0 {
		t.Fatalf("foreign account saw another user's MCP audit: %#v", foreignUsage.body)
	}
	crossBabyUsage, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/me/ai-usage?babyId="+owner.babyID, foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if crossBabyUsage.status != http.StatusNotFound {
		t.Fatalf("foreign user queried an owner's baby usage: %d %#v", crossBabyUsage.status, crossBabyUsage.body)
	}
	refreshForm := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {refresh}, "resource": {resource}, "scope": {"baby:read"}}
	rotated, err := oauthHTTPCall(httpServer.URL, http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", "", oauthFormBody(refreshForm))
	if err != nil {
		t.Fatal(err)
	}
	if rotated.status != http.StatusOK || rotated.object["scope"] != "baby:read" {
		t.Fatalf("refresh did not restrict scopes: %d %s", rotated.status, rotated.body)
	}
	rotatedAccess, rotatedRefresh := text(rotated.object["access_token"]), text(rotated.object["refresh_token"])
	expansion := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {rotatedRefresh}, "resource": {resource}, "scope": {"baby:read baby:write"}}
	expanded, err := oauthHTTPCall(httpServer.URL, http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", "", oauthFormBody(expansion))
	if err != nil {
		t.Fatal(err)
	}
	if expanded.status != http.StatusBadRequest {
		t.Fatalf("refresh expanded its scope: %d", expanded.status)
	}
	reuse := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {refresh}, "resource": {resource}}
	reused, err := oauthHTTPCall(httpServer.URL, http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", "", oauthFormBody(reuse))
	if err != nil {
		t.Fatal(err)
	}
	if reused.status != http.StatusBadRequest {
		t.Fatalf("refresh reuse was not rejected: %d", reused.status)
	}
	if result := probe(rotatedAccess); result.status != http.StatusUnauthorized {
		t.Fatalf("refresh reuse did not revoke access: %d", result.status)
	}
	foreignConnections, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/connections", foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if foreignConnections.status != http.StatusOK || len(foreignConnections.body["data"].([]any)) != 0 {
		t.Fatalf("foreign user saw OAuth grants: %#v", foreignConnections.body)
	}

	// Create a second connection to verify protocol token revocation immediately affects tools.
	code2, verifier2, cookie, _ := oauthAuthorize(t, httpServer.URL, clientID, redirect, resource, owner.username, password, owner.babyID, cookie, track)
	issued2, err := oauthExchange(httpServer.URL, clientID, code2, redirect, verifier2, resource)
	if err != nil || issued2.status != http.StatusOK {
		t.Fatalf("second code exchange: %v, %s", err, issued2.body)
	}
	access2 := text(issued2.object["access_token"])
	revokeForm := url.Values{"client_id": {clientID}, "token": {access2}, "token_type_hint": {"access_token"}}
	revoked2, err := oauthHTTPCall(httpServer.URL, http.MethodPost, "/oauth/revoke", "application/x-www-form-urlencoded", "", oauthFormBody(revokeForm))
	if err != nil {
		t.Fatal(err)
	}
	if revoked2.status != http.StatusOK || probe(access2).status != http.StatusUnauthorized {
		t.Fatalf("OAuth token revocation did not immediately affect MCP tools: status=%d", revoked2.status)
	}

	// A third live connection verifies owner-only DELETE independently of protocol token revocation.
	code3, verifier3, cookie, _ := oauthAuthorize(t, httpServer.URL, clientID, redirect, resource, owner.username, password, owner.babyID, cookie, track)
	issued3, err := oauthExchange(httpServer.URL, clientID, code3, redirect, verifier3, resource)
	if err != nil || issued3.status != http.StatusOK {
		t.Fatalf("third code exchange: %v, %s", err, issued3.body)
	}
	access3 := text(issued3.object["access_token"])
	connections, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/connections", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if connections.status != http.StatusOK || connections.body["managementAvailable"] != true {
		t.Fatalf("owner connection inventory unavailable: %#v", connections.body)
	}
	entries, ok := connections.body["data"].([]any)
	if !ok || len(entries) < 3 {
		t.Fatalf("connection inventory missing grants: %#v", connections.body)
	}
	for _, entry := range entries {
		for _, forbidden := range []string{"token", "tokenHash", "token_hash", "codeHash", "refreshToken"} {
			if _, found := obj(entry)[forbidden]; found {
				t.Fatalf("connection summary leaked credential field %q", forbidden)
			}
		}
	}
	connectionID := ""
	for _, entry := range entries {
		if obj(entry)["revokedAt"] == nil {
			connectionID = text(obj(entry)["id"])
			break
		}
	}
	if connectionID == "" {
		t.Fatalf("no live owner connection available for revocation: %#v", entries)
	}
	foreignDelete, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/connections/"+connectionID, foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if foreignDelete.status != http.StatusNotFound {
		t.Fatalf("foreign connection delete status %d", foreignDelete.status)
	}
	deleted, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/connections/"+connectionID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.status != http.StatusOK {
		t.Fatalf("owner connection delete status %d: %#v", deleted.status, deleted.body)
	}
	if result := probe(access3); result.status != http.StatusUnauthorized {
		t.Fatalf("connection DELETE did not revoke MCP token: %d", result.status)
	}

	// A fourth grant proves soft account deletion also revokes every OAuth credential.
	code4, verifier4, cookie, _ := oauthAuthorize(t, httpServer.URL, clientID, redirect, resource, owner.username, password, owner.babyID, cookie, track)
	issued4, err := oauthExchange(httpServer.URL, clientID, code4, redirect, verifier4, resource)
	if err != nil || issued4.status != http.StatusOK {
		t.Fatalf("fourth code exchange: %v, %s", err, issued4.body)
	}
	access4 := text(issued4.object["access_token"])
	deletedUser, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/me", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if deletedUser.status != http.StatusOK {
		t.Fatalf("isolated test account deletion did not succeed: %d %#v", deletedUser.status, deletedUser.body)
	}
	if result := probe(access4); result.status != http.StatusUnauthorized {
		t.Fatalf("account deletion did not revoke MCP OAuth access: %d", result.status)
	}
	var active int
	if err = server.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM native_go.oauth_grants WHERE user_id=$1 AND revoked_at IS NULL)+(SELECT count(*) FROM native_go.oauth_access a JOIN native_go.oauth_grants g ON g.id=a.grant_id WHERE g.user_id=$1 AND a.revoked_at IS NULL)`, owner.userID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("soft deletion left active OAuth credentials: count=%d err=%v", active, err)
	}
	var ownerUsageRows int
	if err = server.DB.QueryRow(ctx, `SELECT count(*) FROM native_go.mcp_usage_calls WHERE user_id=$1`, owner.userID).Scan(&ownerUsageRows); err != nil || ownerUsageRows != 0 {
		t.Fatalf("soft deletion left owner-scoped MCP usage audit: count=%d err=%v", ownerUsageRows, err)
	}
	if _, err = server.DB.Exec(ctx, `DELETE FROM native_go.oauth_requests WHERE id=ANY($1)`, trackedRequests); err != nil {
		t.Fatalf("clean test OAuth requests: %v", err)
	}
}
