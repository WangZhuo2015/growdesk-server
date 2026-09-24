package main

import (
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/WangZhuo2015/growdesk-server/internal/backend"
)

func TestConfiguredTransportDeadlines(t *testing.T) {
	cfg := backend.Config{Address: "127.0.0.1:18081", RequestTimeout: 12 * time.Second}
	s := configuredHTTPServer(cfg, http.NotFoundHandler())
	if s.ReadTimeout != cfg.RequestTimeout || s.WriteTimeout != cfg.RequestTimeout+5*time.Second {
		t.Fatal("socket deadlines must track the configured request budget")
	}
	if s.ReadHeaderTimeout <= 0 || s.IdleTimeout <= 0 || s.MaxHeaderBytes != 32768 {
		t.Fatal("transport protections were removed")
	}
}

func startTransportTest(t *testing.T, handler http.Handler) (net.Conn, *http.Server) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := configuredHTTPServer(backend.Config{RequestTimeout: 150 * time.Millisecond}, handler)
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		select {
		case err := <-done:
			if !errors.Is(err, http.ErrServerClosed) {
				t.Errorf("server exit: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("test server did not exit")
		}
	})
	conn, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, server
}

func requireTransportTimeout(t *testing.T, result <-chan error, budget time.Duration) {
	t.Helper()
	select {
	case err := <-result:
		var timeout net.Error
		if !errors.As(err, &timeout) || !timeout.Timeout() {
			t.Fatalf("expected transport timeout, got %v", err)
		}
	case <-time.After(budget + 5*time.Second):
		t.Fatal("stalled client retained the handler beyond its deadline")
	}
}

func TestIncompleteRequestBodyTimesOut(t *testing.T) {
	result := make(chan error, 1)
	conn, server := startTransportTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.Copy(io.Discard, r.Body)
		result <- err
	}))
	if _, err := io.WriteString(conn, "POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 20\r\n\r\nx"); err != nil {
		t.Fatal(err)
	}
	requireTransportTimeout(t, result, server.ReadTimeout)
}

type transportZeros struct{}

func (transportZeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestNonReadingClientTimesOut(t *testing.T) {
	result := make(chan error, 1)
	conn, server := startTransportTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bounded generated data fills the socket without allocating a large body.
		_, err := io.CopyN(w, transportZeros{}, 64<<20)
		result <- err
	}))
	if tcp, ok := conn.(*net.TCPConn); ok {
		if err := tcp.SetReadBuffer(1024); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: test\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	// Deliberately do not read. A context timeout alone cannot unblock Write.
	requireTransportTimeout(t, result, server.WriteTimeout)
}
