package backend

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/gorilla/websocket"
)

type streamInterruptionDiagnostic struct {
	streamType            string
	errorClass            string
	websocketCloseCode    int
	hasWebsocketCloseCode bool
}

func classifyStreamInterruption(err error, isWebSocket bool) streamInterruptionDiagnostic {
	streamType := "http"
	if isWebSocket {
		streamType = "websocket"
	}
	diagnostic := streamInterruptionDiagnostic{streamType: streamType, errorClass: "unknown"}
	if err == nil {
		return diagnostic
	}

	switch {
	case errors.Is(err, io.ErrUnexpectedEOF):
		diagnostic.errorClass = "unexpected_eof"
	case errors.Is(err, io.EOF):
		diagnostic.errorClass = "eof"
	case errors.Is(err, context.Canceled):
		diagnostic.errorClass = "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		diagnostic.errorClass = "context_deadline"
	case isNetworkTimeout(err):
		diagnostic.errorClass = "network_timeout"
	case errors.Is(err, net.ErrClosed) || errors.Is(err, os.ErrClosed) || errors.Is(err, websocket.ErrCloseSent):
		diagnostic.errorClass = "closed"
	case errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ENETRESET):
		diagnostic.errorClass = "connection_reset"
	case errors.Is(err, syscall.ECONNABORTED):
		diagnostic.errorClass = "connection_aborted"
	case errors.Is(err, syscall.EPIPE):
		diagnostic.errorClass = "broken_pipe"
	case isWebSocket && errors.Is(err, websocket.ErrReadLimit):
		diagnostic.errorClass = "websocket_read_limit"
	default:
		if isWebSocket {
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				diagnostic.errorClass = "websocket_close"
				diagnostic.websocketCloseCode = closeErr.Code
				diagnostic.hasWebsocketCloseCode = true
			} else if isGorillaProtocolError(err) {
				diagnostic.errorClass = "websocket_protocol"
			}
		}
	}
	return diagnostic
}

func isNetworkTimeout(err error) bool {
	if errors.Is(err, syscall.ETIMEDOUT) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}

// Gorilla v1.5.3 represents frame protocol failures as plain errors, not a
// typed error. Match only the fixed messages emitted by handleProtocolError;
// never log or persist the supplied error text. The numeric forms below are
// constrained to the protocol fields Gorilla formats itself.
func isGorillaProtocolError(err error) bool {
	for depth := 0; err != nil && depth < 16; depth++ {
		if hasSafeGorillaProtocolMessage(err.Error()) {
			return true
		}
		err = errors.Unwrap(err)
	}
	return false
}

func hasSafeGorillaProtocolMessage(message string) bool {
	const prefix = "websocket: "
	if !strings.HasPrefix(message, prefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(message, prefix), ", ")
	if len(parts) == 0 {
		return false
	}
	for _, part := range parts {
		switch part {
		case "RSV1 set", "RSV2 set", "RSV3 set", "len > 125 for control",
			"FIN not set on control", "data before FIN", "continuation after FIN",
			"bad MASK", "invalid utf8 payload in close frame":
			continue
		}
		if isSafeGorillaNumber(part, "bad opcode ", 0, 15) ||
			isSafeGorillaNumber(part, "bad close code ", 0, 65535) {
			continue
		}
		return false
	}
	return true
}

func isSafeGorillaNumber(value, prefix string, min, max int) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	digits := strings.TrimPrefix(value, prefix)
	if digits == "" {
		return false
	}
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	parsed, err := strconv.Atoi(digits)
	return err == nil && parsed >= min && parsed <= max
}

func (s *Server) logStreamInterruption(operationID, requestID string, isWebSocket bool, err error) {
	diagnostic := classifyStreamInterruption(err, isWebSocket)
	attrs := []any{
		"operationId", operationID,
		"requestId", requestID,
		"streamType", diagnostic.streamType,
		"errorClass", diagnostic.errorClass,
	}
	if diagnostic.hasWebsocketCloseCode {
		attrs = append(attrs, "websocketCloseCode", diagnostic.websocketCloseCode)
	}
	s.Log.Warn("stream interrupted", attrs...)
}
