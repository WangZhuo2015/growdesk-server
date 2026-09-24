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
	Experimental          bool
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
		Experimental: os.Getenv("GROWDESK_GO_EXPERIMENTAL") == "1",
		Address:      net.JoinHostPort(envOr("HOST", "127.0.0.1"), envOr("PORT", "3081")),
		Environment:  envOr("GROWDESK_ENV", "development"),
		DatabaseURL:  os.Getenv("DATABASE_URL"), RedisURL: os.Getenv("REDIS_URL"),
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
	if err := c.validateNativeRuntime(); err != nil {
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
	fail := func() error {
		return errors.New("REDIS_CONFIG_REJECTED: explicit host, password, port and database required")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") || u.Hostname() == "" || u.User == nil || u.Fragment != "" || u.RawQuery != "" {
		return fail()
	}
	password, present := u.User.Password()
	if !present || password == "" {
		return fail()
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return fail()
	}
	database := strings.TrimPrefix(u.Path, "/")
	if database == "" {
		return fail()
	}
	for _, c := range database {
		if c < '0' || c > '9' {
			return fail()
		}
	}
	if _, err := strconv.ParseUint(database, 10, 31); err != nil {
		return fail()
	}
	if test && (u.Hostname() != "127.0.0.1" || port == 6379) {
		return errors.New("REDIS_CONFIG_REJECTED: owned loopback and non-default port required")
	}
	return nil
}

// This incremental binary is not a production replacement. The same boundary
// applies to direct NewServer callers, not just environment-based startup.
// Ownership is additionally established by the disposable integration harness.
func (c Config) validateNativeRuntime() error {
	if c.Environment == "production" {
		if len(c.JWTSecret) < 32 || len(c.SessionEncryptionKey) < 32 {
			return errors.New("production requires strong JWT and session encryption keys (at least 32 bytes)")
		}
		host, rawPort, err := net.SplitHostPort(c.Address)
		port, portErr := strconv.Atoi(rawPort)
		if err != nil || portErr != nil || host != "127.0.0.1" || port < 1 || port > 65535 || port == 3088 || port == 3089 {
			return errors.New("production requires an isolated loopback HTTP port distinct from legacy ports 3088 and 3089")
		}
		if err := ValidateDatabaseURL(c.DatabaseURL, false); err != nil {
			return err
		}
		u, _ := url.Parse(c.DatabaseURL)
		if u != nil {
			if u.User.Username() == "postgres" || u.User.Username() == "root" {
				return errors.New("DATABASE_CONFIG_REJECTED: production requires a non-superuser database role")
			}
			name := strings.TrimPrefix(u.Path, "/")
			if testName.MatchString(u.User.Username()) || testName.MatchString(name) {
				return errors.New("DATABASE_CONFIG_REJECTED: production refuses test-prefixed database and role")
			}
		}
		return ValidateRedisURL(c.RedisURL, false)
	}

	if !c.Experimental {
		return errors.New("GROWDESK_GO_EXPERIMENTAL=1 is required for this isolated native preview")
	}
	if c.Environment != "test" && c.Environment != "development" {
		return errors.New("native Go preview refuses production and unknown environments")
	}
	if len(c.JWTSecret) < 32 || len(c.SessionEncryptionKey) < 32 {
		return errors.New("native Go preview requires strong JWT and session encryption keys")
	}
	host, rawPort, err := net.SplitHostPort(c.Address)
	port, portErr := strconv.Atoi(rawPort)
	if err != nil || portErr != nil || host != "127.0.0.1" || port < 1 || port > 65535 || port == 3088 || port == 3089 {
		return errors.New("native Go preview requires an isolated loopback HTTP port")
	}
	if err := ValidateDatabaseURL(c.DatabaseURL, true); err != nil {
		return err
	}
	return ValidateRedisURL(c.RedisURL, true)
}
