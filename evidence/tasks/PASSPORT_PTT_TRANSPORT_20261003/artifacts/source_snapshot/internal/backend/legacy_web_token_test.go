package backend

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestLegacyWebTokenProfile(t *testing.T) {
	secret := strings.Repeat("s", 40)
	now := time.Now().Unix()
	cases := []struct {
		name string
		edit func(jwt.MapClaims)
		valid bool
	}{
		{"original Web", func(c jwt.MapClaims) {}, true},
		{"missing expiry", func(c jwt.MapClaims) { delete(c, "exp") }, false},
		{"missing issue time", func(c jwt.MapClaims) { delete(c, "iat") }, false},
		{"expired", func(c jwt.MapClaims) { c["exp"] = now - 1 }, false},
		{"future issue time", func(c jwt.MapClaims) { c["iat"] = now + 600 }, false},
		{"wrong identity type", func(c jwt.MapClaims) { c["userId"] = 12 }, false},
		{"missing username", func(c jwt.MapClaims) { delete(c, "username") }, false},
		{"MCP profile", func(c jwt.MapClaims) { c["typ"] = "mcp" }, false},
		{"native profile", func(c jwt.MapClaims) { c["typ"] = "at+jwt" }, false},
		{"subject only", func(c jwt.MapClaims) { delete(c, "userId"); c["sub"] = "test_user" }, false},
		{"session profile", func(c jwt.MapClaims) { c["sid"] = "test_session" }, false},
		{"issuer profile", func(c jwt.MapClaims) { c["iss"] = "growdesk-api" }, false},
		{"audience profile", func(c jwt.MapClaims) { c["aud"] = "baby-panel-api" }, false},
		{"scoped profile", func(c jwt.MapClaims) { c["scope"] = "read" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := jwt.MapClaims{"userId": "test_user", "username": "test_name", "iat": now - 60, "exp": now + 3600}
			tc.edit(claims)
			token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
			delete(token.Header, "typ")
			raw, err := token.SignedString([]byte(secret))
			if err != nil { t.Fatal(err) }
			id, err := legacyWebTokenUser(raw, secret)
			if tc.valid {
				if err != nil || id != "test_user" { t.Fatalf("valid profile rejected: %v", err) }
			} else if err == nil || normalizedError(err).Status != 401 {
				t.Fatalf("invalid profile accepted: %v", err)
			}
		})
	}
}
