package backend

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	oauthBrowserSessionTTL = 90*24*time.Hour + 10*time.Minute
	oauthBrowserLoginTTL   = 10 * time.Minute
	oauthCodeTTL           = 5 * time.Minute
	oauthAccessTTL         = 15 * time.Minute
	oauthRefreshTTL        = 90 * 24 * time.Hour
)

func randomOAuthBrowserSecret() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("system random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func oauthExpiryWithinGrant(lifetime time.Duration, grantExpires time.Time) time.Time {
	expires := time.Now().UTC().Add(lifetime)
	if grantExpires.Before(expires) {
		return grantExpires
	}
	return expires
}

type oauthAuthorizeRequest struct {
	ClientID    string   `json:"client_id"`
	ClientName  string   `json:"client_name"`
	RedirectURI string   `json:"redirect_uri"`
	State       string   `json:"state"`
	Challenge   string   `json:"code_challenge"`
	Resource    string   `json:"resource"`
	Scopes      []string `json:"scopes"`
}

func oauthError(code, description string) Result {
	return Result{Status: http.StatusBadRequest, Body: Object{"error": code, "error_description": description}}
}

func validOAuthRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Opaque != "" || u.User != nil || u.Fragment != "" {
		return false
	}
	if strings.EqualFold(u.Scheme, "https") {
		return u.Host != ""
	}
	if strings.EqualFold(u.Scheme, "http") {
		host := strings.ToLower(u.Hostname())
		return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
	}
	// Native-app custom schemes are permitted as exact, non-wildcard URIs.
	return strings.ToLower(u.Scheme) != "javascript" && strings.ToLower(u.Scheme) != "data"
}

func uniqueStrings(values []string) bool {
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

func oauthAllowedScopes(raw string) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	for _, scope := range strings.Fields(raw) {
		if scope != "baby:read" && scope != "baby:write" {
			return nil, fmt.Errorf("unsupported scope")
		}
		if !seen[scope] {
			seen[scope] = true
			out = append(out, scope)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("scope is required")
	}
	sort.Strings(out)
	return out, nil
}

func (s *Server) registerOAuthClient(ctx context.Context, r *Request) (Result, error) {
	name := strings.TrimSpace(text(r.Body["client_name"]))
	redirects := oauthStringList(r.Body["redirect_uris"])
	if name == "" || len([]rune(name)) > 200 || len(redirects) == 0 || len(redirects) > 10 || !uniqueStrings(redirects) {
		return oauthError("invalid_client_metadata", "client_name and unique redirect_uris are required"), nil
	}
	for _, redirect := range redirects {
		if len(redirect) > 2048 || !validOAuthRedirect(redirect) {
			return oauthError("invalid_redirect_uri", "redirect_uris must be absolute, exact URIs without fragments"), nil
		}
	}
	grants := oauthStringList(r.Body["grant_types"])
	if len(grants) > 0 && !sameStringSet(grants, []string{"authorization_code", "refresh_token"}) {
		return oauthError("invalid_client_metadata", "grant_types must allow authorization_code and refresh_token"), nil
	}
	responses := oauthStringList(r.Body["response_types"])
	if len(responses) > 0 && !sameStringSet(responses, []string{"code"}) {
		return oauthError("invalid_client_metadata", "response_types must contain code"), nil
	}
	if method := text(r.Body["token_endpoint_auth_method"]); method != "" && method != "none" {
		return oauthError("invalid_client_metadata", "Only public clients using token_endpoint_auth_method none are supported"), nil
	}
	scopes := []string{"baby:read", "baby:write"}
	if raw := text(r.Body["scope"]); raw != "" {
		var err error
		scopes, err = oauthAllowedScopes(raw)
		if err != nil {
			return oauthError("invalid_scope", err.Error()), nil
		}
	}
	clientID := "mcp_" + newID()
	_, err := s.DB.Exec(ctx, `INSERT INTO native_go.oauth_clients(client_id,client_name,redirect_uris,scopes) VALUES($1,$2,$3,$4)`, clientID, name, redirects, scopes)
	if err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusCreated, Body: Object{"client_id": clientID, "client_id_issued_at": time.Now().Unix(), "client_name": name, "redirect_uris": redirects, "scope": strings.Join(scopes, " "), "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none"}}, nil
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	aa := append([]string(nil), a...)
	bb := append([]string(nil), b...)
	sort.Strings(aa)
	sort.Strings(bb)
	for i := range aa {
		if aa[i] != bb[i] {
			return false
		}
	}
	return true
}

func (s *Server) getOAuthAuthorization(ctx context.Context, r *Request) (Result, error) {
	q := r.HTTP.URL.Query()
	allowedQuery := map[string]bool{"response_type": true, "client_id": true, "redirect_uri": true, "scope": true, "state": true, "code_challenge": true, "code_challenge_method": true, "resource": true}
	for key, values := range q {
		if !allowedQuery[key] || len(values) != 1 {
			return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("The authorization request contains duplicate or unsupported parameters."), nil), nil
		}
	}
	clientID, redirect, resource := q.Get("client_id"), q.Get("redirect_uri"), q.Get("resource")
	var name string
	var redirects, clientScopes []string
	var revoked *time.Time
	err := s.DB.QueryRow(ctx, `SELECT client_name,redirect_uris,scopes,revoked_at FROM native_go.oauth_clients WHERE client_id=$1`, clientID).Scan(&name, &redirects, &clientScopes, &revoked)
	if errors.Is(err, pgx.ErrNoRows) || revoked != nil {
		return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("This client is not registered."), nil), nil
	}
	if err != nil {
		return Result{}, err
	}
	if !containsScope(redirects, redirect) || !validOAuthRedirect(redirect) {
		return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("The redirect URI does not match this client."), nil), nil
	}
	if resource != s.mcpResourceAudience() {
		return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("The requested resource is not available."), nil), nil
	}
	requested := []string{"baby:read"}
	if rawScope := q.Get("scope"); rawScope != "" {
		requested, err = oauthAllowedScopes(rawScope)
		if err != nil {
			return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("The requested scope is invalid."), nil), nil
		}
	}
	for _, scope := range requested {
		if !containsScope(clientScopes, scope) {
			return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("This client did not register the requested scope."), nil), nil
		}
	}
	challenge := q.Get("code_challenge")
	decoded, decodeErr := base64.RawURLEncoding.DecodeString(challenge)
	if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || decodeErr != nil || len(decoded) != sha256.Size || base64.RawURLEncoding.EncodeToString(decoded) != challenge {
		return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("A valid S256 PKCE challenge is required."), nil), nil
	}
	state := q.Get("state")
	if len(state) > 512 {
		return s.oauthHTML(http.StatusBadRequest, oauthErrorPage("State is too long."), nil), nil
	}
	request := oauthAuthorizeRequest{ClientID: clientID, ClientName: name, RedirectURI: redirect, State: state, Challenge: challenge, Resource: resource, Scopes: requested}
	requestID, secret := newID(), randomOAuthBrowserSecret()
	raw, err := jsonBytes(request)
	if err != nil {
		return Result{}, err
	}
	_, err = s.DB.Exec(ctx, `DELETE FROM native_go.oauth_requests WHERE expires_at<clock_timestamp()`)
	if err != nil {
		return Result{}, err
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO native_go.oauth_requests(id,browser_secret_hash,request_json,expires_at) VALUES($1,$2,$3::jsonb,clock_timestamp()+$4::interval)`, requestID, hashText(secret), string(raw), fmt.Sprintf("%f seconds", oauthBrowserLoginTTL.Seconds()))
	if err != nil {
		return Result{}, err
	}
	principal, sessionErr := s.authenticateOAuthBrowser(ctx, r.HTTP)
	data := oauthPageData{RequestID: requestID, Secret: secret, ClientName: name, Scopes: requested}
	if sessionErr == nil {
		data.UserName = principal.Username
		return s.renderOAuthConsent(ctx, data, principal.UserID)
	}
	return s.oauthHTML(http.StatusOK, oauthLoginPage(data), nil), nil
}

type oauthPageData struct {
	RequestID, Secret, ClientName, UserName string
	Scopes                                  []string
	Babies                                  []oauthBabyOption
	Error                                   string
}
type oauthBabyOption struct{ ID, Name, Family string }

func lockOAuthFamiliesForSession(ctx context.Context, tx pgx.Tx, sessionID string) error {
	rows, err := tx.Query(ctx, `SELECT DISTINCT family_id FROM native_go.oauth_grants WHERE session_id=$1 AND revoked_at IS NULL ORDER BY family_id`, sessionID)
	if err != nil {
		return err
	}
	families := []string{}
	for rows.Next() {
		var family string
		if err = rows.Scan(&family); err != nil {
			rows.Close()
			return err
		}
		families = append(families, family)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, family := range families {
		if _, err = lockFamily(ctx, tx, family); err != nil {
			return err
		}
	}
	return nil
}

func lockOAuthFamiliesForUser(ctx context.Context, tx pgx.Tx, userID string) error {
	rows, err := tx.Query(ctx, `SELECT DISTINCT family_id FROM native_go.oauth_grants WHERE user_id=$1 AND revoked_at IS NULL ORDER BY family_id`, userID)
	if err != nil {
		return err
	}
	families := []string{}
	for rows.Next() {
		var family string
		if err = rows.Scan(&family); err != nil {
			rows.Close()
			return err
		}
		families = append(families, family)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, family := range families {
		if _, err = lockFamily(ctx, tx, family); err != nil {
			return err
		}
	}
	return nil
}

var oauthLoginTemplate = template.Must(template.New("login").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in to GrowDesk</title><h1>Sign in to GrowDesk</h1><p>{{.ClientName}} is requesting access to your selected baby records.</p>{{if .Error}}<p role="alert">{{.Error}}</p>{{end}}<form method="post" action="/oauth/authorize"><input type="hidden" name="requestId" value="{{.RequestID}}"><input type="hidden" name="browserSecret" value="{{.Secret}}"><input type="hidden" name="decision" value="login"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></html>`))
var oauthConsentTemplate = template.Must(template.New("consent").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize {{.ClientName}}</title><h1>Authorize {{.ClientName}}</h1><p>Signed in as {{.UserName}}. Review the requested access and choose one baby.</p>{{if .Error}}<p role="alert">{{.Error}}</p>{{end}}<ul>{{range .Scopes}}<li>{{.}}</li>{{end}}</ul>{{if .Babies}}<form method="post" action="/oauth/authorize"><input type="hidden" name="requestId" value="{{.RequestID}}"><input type="hidden" name="browserSecret" value="{{.Secret}}"><input type="hidden" name="scopeSelection" value="true"><label>Baby <select name="babyId" required>{{range .Babies}}<option value="{{.ID}}">{{.Name}} — {{.Family}}</option>{{end}}</select></label>{{range .Scopes}}<label><input type="checkbox" name="scope" value="{{.}}" checked>{{.}}</label>{{end}}<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form>{{else}}<p>No accessible babies are available for this account.</p>{{end}}</html>`))
var oauthErrorTemplate = template.Must(template.New("error").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorization unavailable</title><h1>Authorization unavailable</h1><p role="alert">{{.}}</p></html>`))

func renderTemplate(t *template.Template, data any) []byte {
	var b bytes.Buffer
	_ = t.Execute(&b, data)
	return b.Bytes()
}
func oauthErrorPage(message string) []byte     { return renderTemplate(oauthErrorTemplate, message) }
func oauthLoginPage(data oauthPageData) []byte { return renderTemplate(oauthLoginTemplate, data) }
func (s *Server) oauthHTML(status int, body []byte, headers http.Header) Result {
	if headers == nil {
		headers = http.Header{}
	}
	headers.Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'")
	headers.Set("Referrer-Policy", "no-referrer")
	return Result{Status: status, RawBody: body, ContentType: "text/html; charset=utf-8", Headers: headers}
}

func (s *Server) renderOAuthConsent(ctx context.Context, data oauthPageData, userID string) (Result, error) {
	rows, err := many(ctx, s.DB, `SELECT to_jsonb(oauth_babies) FROM (SELECT b.id,b.nickname AS name,f.name AS family_name FROM babies b JOIN families f ON f.id=b.family_id
	JOIN family_members fm ON fm.family_id=b.family_id AND fm.user_id=$1 AND fm.status='active' AND fm.deleted_at IS NULL
	JOIN baby_members bm ON bm.baby_id=b.id AND bm.family_id=b.family_id AND bm.user_id=$1 AND bm.status='active' AND bm.deleted_at IS NULL
	WHERE b.deleted_at IS NULL AND f.deleted_at IS NULL AND fm.role IN ('admin','member','viewer') AND bm.role IN ('admin','member','viewer') ORDER BY f.name,b.nickname,b.id LIMIT 100) AS oauth_babies`, userID)
	if err != nil {
		return Result{}, err
	}
	for _, row := range rows {
		data.Babies = append(data.Babies, oauthBabyOption{ID: text(row["id"]), Name: text(row["name"]), Family: text(row["family_name"])})
	}
	return s.oauthHTML(http.StatusOK, renderTemplate(oauthConsentTemplate, data), nil), nil
}

func (s *Server) authenticateOAuthBrowser(ctx context.Context, r *http.Request) (Principal, error) {
	cookie, err := r.Cookie("growdesk_oauth_session")
	if err != nil {
		return Principal{}, apiError(401, "UNAUTHORIZED", "Sign in required")
	}
	copy := r.Clone(ctx)
	copy.Header = r.Header.Clone()
	copy.Header.Set("Authorization", "Bearer "+cookie.Value)
	return s.authenticate(ctx, copy)
}

func (s *Server) createOAuthBrowserSession(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	sessionID, label := newID(), "OAuth authorization browser"
	// The persisted device row backs the 90-day grant and remains revocable
	// through the app session inventory. Its signed browser cookie still has a
	// ten-minute lifetime and is scoped to /oauth.
	if _, err := tx.Exec(ctx, `INSERT INTO device_sessions(id,user_id,device_label,platform,absolute_expires_at) VALUES($1,$2,$3,'web',clock_timestamp()+$4::interval)`, sessionID, userID, label, fmt.Sprintf("%f seconds", oauthBrowserSessionTTL.Seconds())); err != nil {
		return "", err
	}
	return s.signAccess(userID, sessionID, label)
}

func (s *Server) loadOAuthRequest(ctx context.Context, id, secret string) (oauthAuthorizeRequest, string, error) {
	var raw []byte
	var dbUserID *string
	err := s.DB.QueryRow(ctx, `SELECT request_json,user_id FROM native_go.oauth_requests WHERE id=$1 AND browser_secret_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, id, hashText(secret)).Scan(&raw, &dbUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthAuthorizeRequest{}, "", apiError(400, "INVALID_AUTHORIZATION_REQUEST", "Authorization request expired or invalid")
	}
	if err != nil {
		return oauthAuthorizeRequest{}, "", err
	}
	var userID string
	if dbUserID != nil {
		userID = *dbUserID
	}
	var req oauthAuthorizeRequest
	if err = decodeJSON(raw, &req); err != nil {
		return req, "", err
	}
	return req, userID, nil
}

func (s *Server) submitOAuthAuthorization(ctx context.Context, r *Request) (Result, error) {
	id, secret := text(r.Body["requestId"]), text(r.Body["browserSecret"])
	request, linkedUser, err := s.loadOAuthRequest(ctx, id, secret)
	if err != nil {
		return Result{}, err
	}
	switch text(r.Body["decision"]) {
	case "login":
		if linkedUser != "" {
			return Result{}, apiError(409, "INVALID_AUTHORIZATION_REQUEST", "This authorization request is already linked; restart authorization")
		}
		username, password := strings.ToLower(strings.TrimSpace(text(r.Body["username"]))), text(r.Body["password"])
		verified, verifyErr := s.verifyCredentials(ctx, username, password)
		if verifyErr != nil {
			return s.oauthHTML(http.StatusOK, oauthLoginPage(oauthPageData{RequestID: id, Secret: secret, ClientName: request.ClientName, Error: "The username or password was not accepted."}), nil), nil
		}
		userID := text(verified["id"])
		tx, txErr := s.DB.Begin(ctx)
		if txErr != nil {
			return Result{}, txErr
		}
		defer rollback(tx)
		if txErr = lockUser(ctx, tx, userID); txErr != nil {
			return Result{}, txErr
		}
		user, txErr := one(ctx, tx, `SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, userID)
		if txErr != nil {
			return Result{}, apiError(401, "INVALID_CREDENTIALS", "Invalid username or password")
		}
		valid, txErr := s.checkPassword(ctx, password, text(user["password_hash"]))
		if txErr != nil {
			return Result{}, txErr
		}
		if !valid {
			return s.oauthHTML(http.StatusOK, oauthLoginPage(oauthPageData{RequestID: id, Secret: secret, ClientName: request.ClientName, Error: "The username or password was not accepted."}), nil), nil
		}
		browserAccess, txErr := s.createOAuthBrowserSession(ctx, tx, userID)
		if txErr != nil {
			return Result{}, txErr
		}
		tag, updateErr := tx.Exec(ctx, `UPDATE native_go.oauth_requests SET user_id=$1 WHERE id=$2 AND browser_secret_hash=$3 AND user_id IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp()`, userID, id, hashText(secret))
		if updateErr != nil {
			return Result{}, updateErr
		}
		if tag.RowsAffected() != 1 {
			return Result{}, apiError(409, "INVALID_AUTHORIZATION_REQUEST", "This authorization request has already been used")
		}
		if txErr = tx.Commit(ctx); txErr != nil {
			return Result{}, txErr
		}
		cookie := (&http.Cookie{Name: "growdesk_oauth_session", Value: browserAccess, Path: "/oauth", HttpOnly: true, Secure: strings.HasPrefix(strings.ToLower(s.oauthBaseURL()), "https://"), SameSite: http.SameSiteStrictMode, MaxAge: int(oauthBrowserLoginTTL.Seconds())}).String()
		result, renderErr := s.renderOAuthConsent(ctx, oauthPageData{RequestID: id, Secret: secret, ClientName: request.ClientName, UserName: username, Scopes: request.Scopes}, userID)
		if renderErr != nil {
			return Result{}, renderErr
		}
		result.Headers.Add("Set-Cookie", cookie)
		return result, nil
	case "deny":
		tag, updateErr := s.DB.Exec(ctx, `UPDATE native_go.oauth_requests SET consumed_at=clock_timestamp() WHERE id=$1 AND browser_secret_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, id, hashText(secret))
		if updateErr != nil {
			return Result{}, updateErr
		}
		if tag.RowsAffected() != 1 {
			return Result{}, apiError(400, "INVALID_AUTHORIZATION_REQUEST", "Authorization request has already been used")
		}
		return s.redirectOAuth(request, "error", "access_denied", nil), nil
	case "allow":
		principal, authErr := s.authenticateOAuthBrowser(ctx, r.HTTP)
		if authErr != nil {
			return Result{}, apiError(401, "UNAUTHORIZED", "Sign in again to authorize this connection")
		}
		if linkedUser != "" && linkedUser != principal.UserID {
			return Result{}, apiError(403, "FORBIDDEN", "This authorization request belongs to another account")
		}
		babyID := text(r.Body["babyId"])
		if babyID == "" {
			return Result{}, invalid("babyId is required")
		}
		scopes := oauthStringList(r.Body["scope"])
		if len(scopes) == 0 {
			if text(r.Body["scopeSelection"]) == "true" {
				return oauthError("invalid_scope", "Select at least one scope to continue"), nil
			}
			scopes = request.Scopes
		}
		scopes, err = oauthAllowedScopes(strings.Join(scopes, " "))
		if err != nil {
			return oauthError("invalid_scope", err.Error()), nil
		}
		for _, scope := range scopes {
			if !containsScope(request.Scopes, scope) {
				return oauthError("invalid_scope", "Consent cannot expand the requested scopes"), nil
			}
		}
		write := containsScope(scopes, "baby:write")
		scope, scopeErr := babyScope(ctx, s.DB, principal.UserID, babyID, write)
		if scopeErr != nil {
			return Result{}, scopeErr
		}
		code := randomHex(32)
		tx, txErr := s.DB.Begin(ctx)
		if txErr != nil {
			return Result{}, txErr
		}
		defer rollback(tx)
		if txErr = lockUser(ctx, tx, principal.UserID); txErr != nil {
			return Result{}, txErr
		}
		if _, txErr = lockFamily(ctx, tx, scope.FamilyID); txErr != nil {
			return Result{}, txErr
		}
		currentScope, scopeErr := babyScope(ctx, tx, principal.UserID, babyID, write)
		if scopeErr != nil {
			return Result{}, scopeErr
		}
		if currentScope.FamilyID != scope.FamilyID {
			return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Baby no longer belongs to the authorized family")
		}
		scope = currentScope
		if _, txErr = one(ctx, tx, `SELECT to_jsonb(d) FROM device_sessions d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.absolute_expires_at>clock_timestamp() AND u.deleted_at IS NULL FOR UPDATE OF d`, principal.SessionID, principal.UserID); txErr != nil {
			return Result{}, apiError(401, "SESSION_REVOKED", "Session has expired or was revoked")
		}
		var active bool
		txErr = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_clients WHERE client_id=$1 AND revoked_at IS NULL AND $2=ANY(redirect_uris))`, request.ClientID, request.RedirectURI).Scan(&active)
		if txErr != nil {
			return Result{}, txErr
		}
		if !active {
			return oauthError("invalid_client", "Client or redirect URI is no longer active"), nil
		}
		tag, txErr := tx.Exec(ctx, `UPDATE native_go.oauth_requests SET consumed_at=clock_timestamp() WHERE id=$1 AND browser_secret_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, id, hashText(secret))
		if txErr != nil {
			return Result{}, txErr
		}
		if tag.RowsAffected() != 1 {
			return oauthError("invalid_request", "authorization request has already been consumed"), nil
		}
		grantID := newID()
		_, txErr = tx.Exec(ctx, `INSERT INTO native_go.oauth_grants(id,user_id,session_id,client_id,family_id,baby_id,audience,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+INTERVAL '90 days')`, grantID, principal.UserID, principal.SessionID, request.ClientID, scope.FamilyID, babyID, request.Resource, scopes)
		if txErr != nil {
			return Result{}, txErr
		}
		_, txErr = tx.Exec(ctx, `INSERT INTO native_go.oauth_codes(code_hash,grant_id,client_id,redirect_uri,challenge,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::interval)`, hashText(code), grantID, request.ClientID, request.RedirectURI, request.Challenge, fmt.Sprintf("%f seconds", oauthCodeTTL.Seconds()))
		if txErr != nil {
			return Result{}, txErr
		}
		if txErr = appendOAuthUserChange(ctx, tx, principal.UserID, grantID, Object{"clientId": request.ClientID, "clientName": request.ClientName, "resource": request.Resource, "scopes": scopes, "familyId": scope.FamilyID, "babyId": babyID}, "upsert"); txErr != nil {
			return Result{}, txErr
		}
		if txErr = tx.Commit(ctx); txErr != nil {
			return Result{}, txErr
		}
		return s.redirectOAuth(request, "code", code, nil), nil
	default:
		return Result{}, invalid("Unsupported authorization decision")
	}
}

func (s *Server) redirectOAuth(request oauthAuthorizeRequest, key, value string, extra url.Values) Result {
	u, _ := url.Parse(request.RedirectURI)
	q := u.Query()
	q.Set(key, value)
	if request.State != "" {
		q.Set("state", request.State)
	}
	if extra != nil {
		for k, vs := range extra {
			for _, v := range vs {
				q.Add(k, v)
			}
		}
	}
	u.RawQuery = q.Encode()
	headers := http.Header{}
	headers.Set("Location", u.String())
	return s.oauthHTML(http.StatusSeeOther, []byte("<!doctype html><html><title>Continue</title><p>Continue to the application.</p></html>"), headers)
}

func appendOAuthUserChange(ctx context.Context, tx pgx.Tx, userID, grantID string, payload Object, op string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO user_sync_states(user_id,epoch,cursor,created_at,updated_at) VALUES($1,$2,0,NOW(),NOW()) ON CONFLICT(user_id) DO NOTHING`, userID, newID()); err != nil {
		return err
	}
	var cursor int64
	if err := tx.QueryRow(ctx, `UPDATE user_sync_states SET cursor=cursor+1,updated_at=NOW() WHERE user_id=$1 RETURNING cursor`, userID).Scan(&cursor); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO user_changes(user_id,cursor,entity_type,entity_id,version,op,payload,schema_version,created_at) VALUES($1,$2,'connection',$3,1,$4,$5::jsonb,1,NOW())`, userID, cursor, grantID, op, mustJSON(payload))
	return err
}

func revokeOAuthSessionGrants(ctx context.Context, tx pgx.Tx, userID, sessionID string) error {
	rows, err := many(ctx, tx, `SELECT to_jsonb(g) FROM native_go.oauth_grants g WHERE g.user_id=$1 AND g.session_id=$2 AND g.revoked_at IS NULL ORDER BY g.id`, userID, sessionID)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1 AND session_id=$2`, userID, sessionID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_access SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id IN (SELECT id FROM native_go.oauth_grants WHERE user_id=$1 AND session_id=$2)`, userID, sessionID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_refresh SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id IN (SELECT id FROM native_go.oauth_grants WHERE user_id=$1 AND session_id=$2)`, userID, sessionID); err != nil {
		return err
	}
	for _, row := range rows {
		if err = appendOAuthUserChange(ctx, tx, userID, text(row["id"]), Object{}, "delete"); err != nil {
			return err
		}
	}
	return nil
}

func revokeOAuthUserGrants(ctx context.Context, tx pgx.Tx, userID, exceptSession string) error {
	rows, err := many(ctx, tx, `SELECT to_jsonb(g) FROM native_go.oauth_grants g WHERE g.user_id=$1 AND ($2='' OR g.session_id<>$2) AND g.revoked_at IS NULL ORDER BY g.id`, userID, exceptSession)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1 AND ($2='' OR session_id<>$2)`, userID, exceptSession); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_access SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id IN (SELECT id FROM native_go.oauth_grants WHERE user_id=$1 AND ($2='' OR session_id<>$2))`, userID, exceptSession); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_refresh SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id IN (SELECT id FROM native_go.oauth_grants WHERE user_id=$1 AND ($2='' OR session_id<>$2))`, userID, exceptSession); err != nil {
		return err
	}
	for _, row := range rows {
		if err = appendOAuthUserChange(ctx, tx, userID, text(row["id"]), Object{}, "delete"); err != nil {
			return err
		}
	}
	return nil
}

func mustJSON(v any) string { raw, _ := jsonBytes(v); return string(raw) }

func oauthStringList(value any) []string {
	switch v := value.(type) {
	case string:
		return []string{v}
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if text(item) != "" {
				out = append(out, text(item))
			}
		}
		return out
	}
	return nil
}

func (s *Server) exchangeOAuthToken(ctx context.Context, r *Request) (Result, error) {
	grantType, clientID := text(r.Body["grant_type"]), text(r.Body["client_id"])
	if clientID == "" {
		return oauthError("invalid_client", "client_id is required"), nil
	}
	var clientActive bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_clients WHERE client_id=$1 AND revoked_at IS NULL)`, clientID).Scan(&clientActive); err != nil {
		return Result{}, err
	}
	if !clientActive {
		return oauthError("invalid_client", "client is not registered"), nil
	}
	switch grantType {
	case "authorization_code":
		return s.exchangeOAuthCode(ctx, r, clientID)
	case "refresh_token":
		return s.rotateOAuthRefresh(ctx, r, clientID)
	default:
		return oauthError("unsupported_grant_type", "grant_type is not supported"), nil
	}
}

func (s *Server) exchangeOAuthCode(ctx context.Context, r *Request, clientID string) (Result, error) {
	code, redirect, verifier, resource := text(r.Body["code"]), text(r.Body["redirect_uri"]), text(r.Body["code_verifier"]), text(r.Body["resource"])
	if code == "" || redirect == "" || resource != s.mcpResourceAudience() || len(verifier) < 43 || len(verifier) > 128 {
		return oauthError("invalid_grant", "authorization code, redirect, verifier and exact MCP resource are required"), nil
	}
	for _, c := range verifier {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.Contains("-._~", string(c))) {
			return oauthError("invalid_grant", "invalid PKCE verifier"), nil
		}
	}
	challengeBytes := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes[:])
	var userID, sessionID, familyID, grantID, audience string
	var grantedScopes []string
	err := s.DB.QueryRow(ctx, `SELECT g.user_id,g.session_id,g.family_id,g.id,g.audience,g.scopes FROM native_go.oauth_codes c JOIN native_go.oauth_grants g ON g.id=c.grant_id WHERE c.code_hash=$1 AND c.client_id=$2 AND c.redirect_uri=$3`, hashText(code), clientID, redirect).Scan(&userID, &sessionID, &familyID, &grantID, &audience, &grantedScopes)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthError("invalid_grant", "authorization code is invalid"), nil
	}
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, userID); err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	var lockedSession string
	err = tx.QueryRow(ctx, `SELECT d.id FROM device_sessions d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.absolute_expires_at>clock_timestamp() AND u.deleted_at IS NULL FOR UPDATE OF d`, sessionID, userID).Scan(&lockedSession)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthError("invalid_grant", "authorization session is no longer active"), nil
	}
	if err != nil {
		return Result{}, err
	}
	var lockedGrant string
	var grantExpires time.Time
	err = tx.QueryRow(ctx, `SELECT id,expires_at FROM native_go.oauth_grants WHERE id=$1 AND user_id=$2 AND session_id=$3 AND client_id=$4 AND audience=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, grantID, userID, sessionID, clientID, resource).Scan(&lockedGrant, &grantExpires)
	if errors.Is(err, pgx.ErrNoRows) || audience != resource {
		return oauthError("invalid_grant", "authorization grant is no longer active"), nil
	}
	if err != nil {
		return Result{}, err
	}
	var storedChallenge string
	var usedAt *time.Time
	var expires time.Time
	err = tx.QueryRow(ctx, `SELECT challenge,used_at,expires_at FROM native_go.oauth_codes WHERE code_hash=$1 AND grant_id=$2 AND client_id=$3 AND redirect_uri=$4 FOR UPDATE`, hashText(code), grantID, clientID, redirect).Scan(&storedChallenge, &usedAt, &expires)
	if errors.Is(err, pgx.ErrNoRows) || usedAt != nil || !expires.After(time.Now()) || storedChallenge != challenge {
		return oauthError("invalid_grant", "authorization code is invalid, expired, or already used"), nil
	}
	if err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_codes SET used_at=clock_timestamp() WHERE code_hash=$1 AND used_at IS NULL`, hashText(code)); err != nil {
		return Result{}, err
	}
	access, refresh := "mcp_at_"+randomHex(32), "mcp_rt_"+randomHex(32)
	accessUntil := oauthExpiryWithinGrant(oauthAccessTTL, grantExpires)
	refreshUntil := oauthExpiryWithinGrant(oauthRefreshTTL, grantExpires)
	accessSeconds := int(time.Until(accessUntil).Seconds())
	if accessSeconds < 1 {
		return oauthError("invalid_grant", "authorization grant has expired"), nil
	}
	if _, err = tx.Exec(ctx, `INSERT INTO native_go.oauth_access(token_hash,grant_id,scopes,expires_at) VALUES($1,$2,$3,$4)`, hashText(access), grantID, grantedScopes, accessUntil); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO native_go.oauth_refresh(token_hash,grant_id,scopes,expires_at) VALUES($1,$2,$3,$4)`, hashText(refresh), grantID, grantedScopes, refreshUntil); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET last_used_at=clock_timestamp() WHERE id=$1`, grantID); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return oauthTokenResponse(access, refresh, grantedScopes, accessSeconds), nil
}

func oauthTokenResponse(access, refresh string, scopes []string, expires int) Result {
	return Result{Status: http.StatusOK, Body: Object{"access_token": access, "token_type": "Bearer", "expires_in": expires, "refresh_token": refresh, "scope": strings.Join(scopes, " ")}}
}

func (s *Server) rotateOAuthRefresh(ctx context.Context, r *Request, clientID string) (Result, error) {
	if text(r.Body["resource"]) != s.mcpResourceAudience() {
		return oauthError("invalid_target", "resource must exactly match the MCP endpoint"), nil
	}
	rawToken := text(r.Body["refresh_token"])
	if !strings.HasPrefix(rawToken, "mcp_rt_") || len(rawToken) != len("mcp_rt_")+64 {
		return oauthError("invalid_grant", "refresh token is invalid"), nil
	}
	var userID, sessionID, familyID, grantID string
	var scopes []string
	err := s.DB.QueryRow(ctx, `SELECT g.user_id,g.session_id,g.family_id,g.id,t.scopes FROM native_go.oauth_refresh t JOIN native_go.oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND g.client_id=$2`, hashText(rawToken), clientID).Scan(&userID, &sessionID, &familyID, &grantID, &scopes)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthError("invalid_grant", "refresh token is invalid"), nil
	}
	if err != nil {
		return Result{}, err
	}
	requested := scopes
	if raw := text(r.Body["scope"]); raw != "" {
		requested, err = oauthAllowedScopes(raw)
		if err != nil {
			return oauthError("invalid_scope", err.Error()), nil
		}
		for _, scope := range requested {
			if !containsScope(scopes, scope) {
				return oauthError("invalid_scope", "refresh cannot expand granted scopes"), nil
			}
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, userID); err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	var lockedSession string
	err = tx.QueryRow(ctx, `SELECT d.id FROM device_sessions d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.absolute_expires_at>clock_timestamp() AND u.deleted_at IS NULL FOR UPDATE OF d`, sessionID, userID).Scan(&lockedSession)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthError("invalid_grant", "authorization session is no longer active"), nil
	}
	if err != nil {
		return Result{}, err
	}
	var grantRevoked *time.Time
	var grantExpires time.Time
	err = tx.QueryRow(ctx, `SELECT revoked_at,expires_at FROM native_go.oauth_grants WHERE id=$1 AND client_id=$2 AND audience=$3 FOR UPDATE`, grantID, clientID, s.mcpResourceAudience()).Scan(&grantRevoked, &grantExpires)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthError("invalid_grant", "authorization grant is no longer active"), nil
	}
	if err != nil {
		return Result{}, err
	}
	if grantRevoked != nil || !grantExpires.After(time.Now()) {
		return oauthError("invalid_grant", "authorization grant is no longer active"), nil
	}
	var usedAt, revokedAt *time.Time
	var tokenExpires time.Time
	err = tx.QueryRow(ctx, `SELECT used_at,revoked_at,expires_at FROM native_go.oauth_refresh WHERE token_hash=$1 AND grant_id=$2 FOR UPDATE`, hashText(rawToken), grantID).Scan(&usedAt, &revokedAt, &tokenExpires)
	if errors.Is(err, pgx.ErrNoRows) {
		return oauthError("invalid_grant", "refresh token is invalid"), nil
	}
	if err != nil {
		return Result{}, err
	}
	if usedAt != nil {
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1`, grantID); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_access SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id=$1`, grantID); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_refresh SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id=$1`, grantID); err != nil {
			return Result{}, err
		}
		if err = appendOAuthUserChange(ctx, tx, userID, grantID, Object{}, "delete"); err != nil {
			return Result{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return oauthError("invalid_grant", "refresh token reuse revoked the connection"), nil
	}
	if revokedAt != nil || !tokenExpires.After(time.Now()) {
		return oauthError("invalid_grant", "refresh token is revoked or expired"), nil
	}
	access, newRefresh := "mcp_at_"+randomHex(32), "mcp_rt_"+randomHex(32)
	accessUntil := oauthExpiryWithinGrant(oauthAccessTTL, grantExpires)
	refreshUntil := oauthExpiryWithinGrant(oauthRefreshTTL, grantExpires)
	accessSeconds := int(time.Until(accessUntil).Seconds())
	if accessSeconds < 1 {
		return oauthError("invalid_grant", "authorization grant has expired"), nil
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_refresh SET used_at=clock_timestamp(),replacement_hash=$2 WHERE token_hash=$1 AND used_at IS NULL`, hashText(rawToken), hashText(newRefresh)); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO native_go.oauth_access(token_hash,grant_id,scopes,expires_at) VALUES($1,$2,$3,$4)`, hashText(access), grantID, requested, accessUntil); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO native_go.oauth_refresh(token_hash,grant_id,scopes,expires_at) VALUES($1,$2,$3,$4)`, hashText(newRefresh), grantID, requested, refreshUntil); err != nil {
		return Result{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET last_used_at=clock_timestamp() WHERE id=$1`, grantID); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return oauthTokenResponse(access, newRefresh, requested, accessSeconds), nil
}

func (s *Server) revokeOAuthToken(ctx context.Context, r *Request) (Result, error) {
	clientID, raw := text(r.Body["client_id"]), text(r.Body["token"])
	if clientID == "" || raw == "" {
		return oauthError("invalid_request", "client_id and token are required"), nil
	}
	var clientActive bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_go.oauth_clients WHERE client_id=$1 AND revoked_at IS NULL)`, clientID).Scan(&clientActive); err != nil {
		return Result{}, err
	}
	if !clientActive {
		return Result{Status: http.StatusOK, Body: Object{"success": true}}, nil
	}
	var userID, sessionID, familyID, grantID string
	err := s.DB.QueryRow(ctx, `SELECT g.user_id,g.session_id,g.family_id,g.id FROM native_go.oauth_access a JOIN native_go.oauth_grants g ON g.id=a.grant_id WHERE a.token_hash=$1 AND g.client_id=$2 UNION ALL SELECT g.user_id,g.session_id,g.family_id,g.id FROM native_go.oauth_refresh t JOIN native_go.oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND g.client_id=$2 LIMIT 1`, hashText(raw), clientID).Scan(&userID, &sessionID, &familyID, &grantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{Status: http.StatusOK, Body: Object{"success": true}}, nil
	}
	if err != nil {
		return Result{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer rollback(tx)
	if err = lockUser(ctx, tx, userID); err != nil {
		return Result{}, err
	}
	if _, err = lockFamily(ctx, tx, familyID); err != nil {
		return Result{}, err
	}
	var ignored string
	sessionErr := tx.QueryRow(ctx, `SELECT id FROM device_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, sessionID, userID).Scan(&ignored)
	if sessionErr != nil && !errors.Is(sessionErr, pgx.ErrNoRows) {
		return Result{}, sessionErr
	}
	var revoked *time.Time
	err = tx.QueryRow(ctx, `SELECT revoked_at FROM native_go.oauth_grants WHERE id=$1 AND client_id=$2 FOR UPDATE`, grantID, clientID).Scan(&revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{Status: http.StatusOK, Body: Object{"success": true}}, nil
	}
	if err != nil {
		return Result{}, err
	}
	if revoked == nil {
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, grantID); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_access SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id=$1`, grantID); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, `UPDATE native_go.oauth_refresh SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_id=$1`, grantID); err != nil {
			return Result{}, err
		}
		if err = appendOAuthUserChange(ctx, tx, userID, grantID, Object{}, "delete"); err != nil {
			return Result{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: http.StatusOK, Body: Object{"success": true}}, nil
}
