package backend

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type diagnosticTimeoutError struct{}

func (diagnosticTimeoutError) Error() string   { return "credential=do-not-log" }
func (diagnosticTimeoutError) Timeout() bool   { return true }
func (diagnosticTimeoutError) Temporary() bool { return true }

func TestClassifyStreamInterruption(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		isWebSocket bool
		wantClass   string
	}{
		{name: "unexpected eof wrapped", err: fmt.Errorf("read: %w", io.ErrUnexpectedEOF), wantClass: "unexpected_eof"},
		{name: "eof wrapped", err: fmt.Errorf("read: %w", io.EOF), wantClass: "eof"},
		{name: "context canceled wrapped", err: fmt.Errorf("stream: %w", context.Canceled), wantClass: "context_canceled"},
		{name: "context deadline wrapped", err: fmt.Errorf("stream: %w", context.DeadlineExceeded), wantClass: "context_deadline"},
		{name: "network timeout", err: diagnosticTimeoutError{}, wantClass: "network_timeout"},
		{name: "closed connection", err: fmt.Errorf("read: %w", net.ErrClosed), wantClass: "closed"},
		{name: "closed file sentinel", err: os.ErrClosed, wantClass: "closed"},
		{name: "reset", err: fmt.Errorf("read: %w", syscall.ECONNRESET), wantClass: "connection_reset"},
		{name: "aborted", err: syscall.ECONNABORTED, wantClass: "connection_aborted"},
		{name: "broken pipe", err: fmt.Errorf("write: %w", syscall.EPIPE), wantClass: "broken_pipe"},
		{name: "read limit wrapped", err: fmt.Errorf("read: %w", websocket.ErrReadLimit), isWebSocket: true, wantClass: "websocket_read_limit"},
		{name: "known protocol message", err: errors.New("websocket: RSV1 set, bad MASK"), isWebSocket: true, wantClass: "websocket_protocol"},
		{name: "wrapped protocol message", err: fmt.Errorf("frame: %w", errors.New("websocket: bad opcode 9")), isWebSocket: true, wantClass: "websocket_protocol"},
		{name: "unrecognized secret is unknown", err: errors.New("Authorization: Bearer secret-value"), isWebSocket: true, wantClass: "unknown"},
		{name: "protocol-like secret is unknown", err: errors.New("websocket: bad MASK; token=secret-value"), isWebSocket: true, wantClass: "unknown"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := classifyStreamInterruption(test.err, test.isWebSocket)
			if got.errorClass != test.wantClass {
				t.Fatalf("errorClass = %q, want %q", got.errorClass, test.wantClass)
			}
			wantStreamType := "http"
			if test.isWebSocket {
				wantStreamType = "websocket"
			}
			if got.streamType != wantStreamType {
				t.Fatalf("streamType = %q, want %q", got.streamType, wantStreamType)
			}
		})
	}
}

func TestServeHTTPLogsSafeUnknownHTTPStreamError(t *testing.T) {
	const secret = "Authorization: Bearer stream-secret"
	var logOutput strings.Builder
	server := newStreamDiagnosticTestServer(t, "getAiRunEvents", errors.New(secret), slog.New(slog.NewTextHandler(&logOutput, nil)))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ai/runs/00000000-0000-4000-8000-000000000001/events", nil)
	server.ServeHTTP(httptest.NewRecorder(), req)

	logged := logOutput.String()
	if !strings.Contains(logged, "streamType=http") || !strings.Contains(logged, "errorClass=unknown") {
		t.Fatalf("missing safe HTTP stream diagnostic: %s", logged)
	}
	if strings.Contains(logged, secret) || strings.Contains(logged, "stream-secret") {
		t.Fatalf("raw stream error was logged: %s", logged)
	}
}

func TestServeHTTPLogsWebSocketCloseCodeWithoutReason(t *testing.T) {
	const secretReason = "token=private-close-reason"
	var logOutput strings.Builder
	server := newStreamDiagnosticTestServer(t, "connectPassportWebSocket", &websocket.CloseError{Code: 4001, Text: secretReason}, slog.New(slog.NewTextHandler(&logOutput, nil)))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/passport/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	server.ServeHTTP(httptest.NewRecorder(), req)

	logged := logOutput.String()
	if !strings.Contains(logged, "streamType=websocket") || !strings.Contains(logged, "errorClass=websocket_close") || !strings.Contains(logged, "websocketCloseCode=4001") {
		t.Fatalf("missing safe WebSocket close diagnostic: %s", logged)
	}
	if strings.Contains(logged, secretReason) || strings.Contains(logged, "private-close-reason") {
		t.Fatalf("WebSocket close reason was logged: %s", logged)
	}
}

func newStreamDiagnosticTestServer(t *testing.T, operationID string, streamErr error, logger *slog.Logger) *Server {
	t.Helper()
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	if contract.ByID[operationID] == nil {
		t.Fatalf("operation %q is missing from contract", operationID)
	}
	return &Server{
		Contract: contract,
		Config:   Config{RequestTimeout: time.Minute},
		Handlers: map[string]Handler{
			operationID: func(context.Context, *Request) (Result, error) {
				return Result{Stream: func(http.ResponseWriter) error { return streamErr }}, nil
			},
		},
		Public: map[string]bool{operationID: true},
		Log:    logger,
		slots:  make(chan struct{}, 1),
	}
}
