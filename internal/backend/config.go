package backend

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address               string
	Environment           string
	DatabaseURL           string
	RedisURL              string
	JWTSecret             string
	SessionEncryptionKey  string
	InvitePepper          string
	PublicURL             string
	MaxDBConnections      int32
	MaxConcurrentRequests int
	RequestTimeout        time.Duration
	MaxBodyBytes          int64
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func LoadConfig() (Config, error) {
	c := Config{
		Address:     net.JoinHostPort(envOr("HOST", "127.0.0.1"), envOr("PORT", "3081")),
		Environment: envOr("GROWDESK_ENV", "development"),
		DatabaseURL: os.Getenv("DATABASE_URL"), RedisURL: os.Getenv("REDIS_URL"),
		JWTSecret: os.Getenv("JWT_SECRET"), SessionEncryptionKey: os.Getenv("SESSION_ENCRYPTION_KEY"),
		InvitePepper: envOr("INVITE_SECRET", os.Getenv("INVITE_CODE_PEPPER")), PublicURL: envOr("PUBLIC_BASE_URL", "http://127.0.0.1:3081"),
		MaxDBConnections: 10, MaxConcurrentRequests: 256, RequestTimeout: 30 * time.Second, MaxBodyBytes: 1048576,
	}
	if c.Environment != "test" && c.Environment != "development" && c.Environment != "production" {
		return c, errors.New("invalid GROWDESK_ENV")
	}
	for _, setting := range []struct {
		name     string
		min, max int
		set      func(int)
	}{
		{"DB_POOL_MAX", 1, 256, func(n int) { c.MaxDBConnections = int32(n) }},
		{"HTTP_MAX_CONCURRENCY", 1, 10000, func(n int) { c.MaxConcurrentRequests = n }},
		{"HTTP_TIMEOUT_SECONDS", 1, 600, func(n int) { c.RequestTimeout = time.Duration(n) * time.Second }},
	} {
		if raw := os.Getenv(setting.name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < setting.min || n > setting.max {
				return c, fmt.Errorf("invalid %s", setting.name)
			}
			setting.set(n)
		}
	}
	if len(c.JWTSecret) < 32 {
		return c, errors.New("JWT_SECRET must contain at least 32 bytes; there is no development-key fallback")
	}
	if c.SessionEncryptionKey == "" {
		c.SessionEncryptionKey = c.JWTSecret
	}
	if len(c.SessionEncryptionKey) < 32 {
		return c, errors.New("SESSION_ENCRYPTION_KEY must contain at least 32 bytes")
	}
	if err := ValidateDatabaseURL(c.DatabaseURL, c.Environment == "test"); err != nil {
		return c, err
	}
	if err := ValidateRedisURL(c.RedisURL, c.Environment == "test"); err != nil {
		return c, err
	}
	return c, nil
}

var testName = regexp.MustCompile(`(?i)^test_[a-z0-9_]+$`)

// ValidateDatabaseURL is a fail-closed parser, not proof of test-instance ownership.
// The integration harness separately creates and identifies the owned container.
func ValidateDatabaseURL(raw string, test bool) error {
	fail := func() error {
		return errors.New("DATABASE_CONFIG_REJECTED: explicit PostgreSQL host, credentials and database required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "postgresql" || u.Hostname() == "" || u.User == nil || u.Fragment != "" {
		return fail()
	}
	password, ok := u.User.Password()
	if !ok || password == "" || u.User.Username() == "" {
		return fail()
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" || strings.Contains(name, "/") {
		return fail()
	}
	port := 5432
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return fail()
		}
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return fail()
	}
	for key, values := range query {
		if key != "sslmode" || len(values) != 1 {
			return fail()
		}
	}
	if test && (u.Hostname() != "127.0.0.1" || port == 5432 || !testName.MatchString(name) || !testName.MatchString(u.User.Username()) || (query.Get("sslmode") != "" && query.Get("sslmode") != "disable")) {
		return errors.New("DATABASE_CONFIG_REJECTED: test mode requires owned loopback, non-default port and test_ database/role")
	}
	return nil
}

func ValidateRedisURL(raw string, test bool) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") || u.Hostname() == "" || u.Fragment != "" || u.RawQuery != "" {
		return errors.New("REDIS_CONFIG_REJECTED")
	}
	if test && (u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Port() == "6379") {
		return errors.New("REDIS_CONFIG_REJECTED: owned loopback and non-default port required")
	}
	return nil
}
