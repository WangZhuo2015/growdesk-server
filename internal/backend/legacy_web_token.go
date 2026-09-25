package backend

import (
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

func invalidLegacyWebToken() error {
	return apiError(401, "INVALID_LEGACY_TOKEN", "Invalid or expired legacy authentication token")
}

// The former Web signAuthToken emits userId, username, iat and exp, with
// HS256 and no application token type, issuer, audience or session ID.
// This exchange must not accept native access/MCP tokens sharing the key:
// those credentials have revocation/scope rules that only their own verifier
// can enforce. In particular, never substitute a native sub for userId.
func legacyWebTokenUser(raw, secret string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 8192 || len(secret) < 32 {
		return "", invalidLegacyWebToken()
	}
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(_ *jwt.Token) (any, error) {
		return []byte(secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || token == nil || !token.Valid {
		return "", invalidLegacyWebToken()
	}
	if typ, present := token.Header["typ"]; present && typ != "JWT" {
		return "", invalidLegacyWebToken()
	}
	for _, name := range []string{"typ", "sub", "sid", "iss", "aud", "scope", "scp", "client_id"} {
		if _, present := claims[name]; present {
			return "", invalidLegacyWebToken()
		}
	}
	user, userOK := claims["userId"].(string)
	username, nameOK := claims["username"].(string)
	if !userOK || user == "" || strings.TrimSpace(user) != user || len(user) > 128 ||
		!nameOK || strings.TrimSpace(username) == "" || len(username) > 512 {
		return "", invalidLegacyWebToken()
	}
	issued, err := claims.GetIssuedAt()
	if err != nil || issued == nil {
		return "", invalidLegacyWebToken()
	}
	expires, err := claims.GetExpirationTime()
	if err != nil || expires == nil || !expires.After(issued.Time) {
		return "", invalidLegacyWebToken()
	}
	return user, nil
}
