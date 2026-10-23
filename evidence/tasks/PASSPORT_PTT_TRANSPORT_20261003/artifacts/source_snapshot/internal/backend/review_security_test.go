package backend

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestNativePreviewRuntimeBoundary(t *testing.T) {
	good := Config{Experimental: true, Environment: "test", Address: "127.0.0.1:18081",
		JWTSecret: strings.Repeat("j", 40), SessionEncryptionKey: strings.Repeat("k", 40),
		DatabaseURL: "postgresql://test_user:test_pass@127.0.0.1:15432/test_review?sslmode=disable",
		RedisURL:    "redis://default:test_pass@127.0.0.1:16379/0"}
	if err := good.validateNativeRuntime(); err != nil {
		t.Fatal(err)
	}
	dev := good
	dev.Environment = "development"
	if err := dev.validateNativeRuntime(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*Config)
	}{
		{"explicit opt-in", func(c *Config) { c.Experimental = false }},
		{"production", func(c *Config) { c.Environment = "production" }},
		{"unknown environment", func(c *Config) { c.Environment = "staging" }},
		{"public listener", func(c *Config) { c.Address = "0.0.0.0:18081" }},
		{"reserved listener", func(c *Config) { c.Address = "127.0.0.1:3088" }},
		{"remote database", func(c *Config) { c.DatabaseURL = "postgresql://test_user:test_pass@prod.example:15432/test_review" }},
		{"non-test identity", func(c *Config) { c.DatabaseURL = "postgresql://app:test_pass@127.0.0.1:15432/production" }},
		{"weak JWT", func(c *Config) { c.JWTSecret = "short" }},
		{"weak encryption key", func(c *Config) { c.SessionEncryptionKey = "short" }},
		{"unauthenticated Redis", func(c *Config) { c.RedisURL = "redis://127.0.0.1:16379/0" }},
		{"remote Redis", func(c *Config) { c.RedisURL = "redis://default:pass@prod.example:16379/0" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := good
			tc.change(&c)
			if c.validateNativeRuntime() == nil {
				t.Fatal("unsafe runtime accepted")
			}
		})
	}
}

func TestRedisGuardRejectsAmbiguousURLs(t *testing.T) {
	for _, url := range []string{
		"redis://default:pass@127.0.0.1:6379/0", "redis://default:pass@127.0.0.1:0/0",
		"redis://default:pass@127.0.0.1:99999/0", "redis://default:pass@127.0.0.1/0",
		"redis://default:pass@127.0.0.1:16379", "redis://default:pass@127.0.0.1:16379//0",
		"redis://default:pass@127.0.0.1:16379/-1", "redis://default:pass@127.0.0.1:16379/0?addr=remote",
		"redis://default:@127.0.0.1:16379/0", "redis://default:pass@127.0.0.1:16379/0#fragment",
	} {
		if ValidateRedisURL(url, true) == nil {
			t.Fatalf("accepted %s", url)
		}
	}
}

func TestNativeBcryptDoesNotPerpetuallyUpgrade(t *testing.T) {
	s := &Server{hashSlots: make(chan struct{}, 1)}
	password := "test_password_" + strings.Repeat("中", 25)
	hash, err := s.passwordHash(context.Background(), password, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$2b$10$") {
		t.Fatal("native password would be treated as legacy on every login")
	}
	if cost, err := bcrypt.Cost([]byte(hash)); err != nil || cost != 10 {
		t.Fatal("password cost changed")
	}
	if valid, err := s.checkPassword(context.Background(), password, hash); err != nil || !valid {
		t.Fatal("native hash failed verification")
	}
	if valid, err := s.checkPassword(context.Background(), "test_wrong_password", hash); err != nil || valid {
		t.Fatal("wrong password accepted")
	}
	legacy := "$2a$" + hash[4:]
	if valid, err := s.checkPassword(context.Background(), password, legacy); err != nil || !valid {
		t.Fatal("legacy bcrypt compatibility changed")
	}
}

func TestJSONMediaTypeMustBeExact(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Contract: contract, Handlers: map[string]Handler{}, Public: map[string]bool{},
		Config: Config{MaxBodyBytes: 1024, RequestTimeout: time.Second}, slots: make(chan struct{}, 1),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	s.registerHealth()
	for _, tc := range []struct {
		media  string
		status int
	}{
		{"application/json", 200}, {"application/json; charset=utf-8", 200}, {"Application/JSON", 200},
		{"application/jsonp", 415}, {"application/json-malformed", 415}, {"application/json; broken", 415},
	} {
		t.Run(tc.media, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/health/live", strings.NewReader(`{}`))
			req.Header.Set("Content-Type", tc.media)
			out := httptest.NewRecorder()
			s.ServeHTTP(out, req)
			if out.Code != tc.status {
				t.Fatalf("status = %d, want %d", out.Code, tc.status)
			}
		})
	}
}
