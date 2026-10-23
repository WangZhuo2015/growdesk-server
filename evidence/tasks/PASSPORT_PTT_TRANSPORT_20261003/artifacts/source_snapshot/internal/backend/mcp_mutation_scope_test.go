package backend

import (
	"context"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestMcpMutationCredentialBoundary(t *testing.T) {
	fresh := func() *mcpAuthContext {
		return &mcpAuthContext{
			principal: Principal{UserID: "test_user", SessionID: "test_session"},
			claims: jwt.MapClaims{"exp": float64(time.Now().Add(time.Hour).Unix())},
			scopes: map[string]bool{"baby:write": true}, babyID: "test_baby",
		}
	}
	for _, scope := range []string{"baby:write", "app:write"} {
		auth := fresh()
		auth.scopes = map[string]bool{scope: true}
		if err := validateMcpMutationCredential(auth, "test_baby"); err != nil {
			t.Fatalf("valid %s profile rejected: %v", scope, err)
		}
	}
	cases := []struct {
		name string
		edit func(*mcpAuthContext)
		status int
	}{
		{"empty identity", func(a *mcpAuthContext) { a.principal.UserID = "" }, 401},
		{"missing expiration", func(a *mcpAuthContext) { delete(a.claims, "exp") }, 401},
		{"invalid expiration", func(a *mcpAuthContext) { a.claims["exp"] = "tomorrow" }, 401},
		{"expired", func(a *mcpAuthContext) { a.claims["exp"] = float64(time.Now().Add(-time.Minute).Unix()) }, 401},
		{"read-only", func(a *mcpAuthContext) { a.scopes = map[string]bool{"baby:read": true} }, 403},
		{"different baby", func(a *mcpAuthContext) { a.babyID = "test_other_baby" }, 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			auth := fresh()
			tc.edit(auth)
			// A nil transaction proves rejected credentials never reach storage.
			_, err := lockMcpMutationScope(context.Background(), nil, auth, "test_baby", "test_family")
			if err == nil || normalizedError(err).Status != tc.status {
				t.Fatalf("got %v; expected %d", err, tc.status)
			}
		})
	}
	if _, err := lockMcpMutationScope(context.Background(), nil, nil, "test_baby", "test_family"); err == nil {
		t.Fatal("missing authentication accepted")
	}
}
