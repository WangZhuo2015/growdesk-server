package backend

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Register the exact declared path, retaining the frozen operationId. A typo or
// contract change fails at startup rather than silently exposing a new API.
func (s *Server) registerDeclared(method, path string, h Handler) {
	for _, route := range s.Contract.Routes {
		if route.Method == method && route.Path == path {
			s.Register(route.OperationID, false, h)
			return
		}
	}
	panic("native handler without declared route: " + method + " " + path)
}

var companionCursorID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func companionCursor(raw, code string) (time.Time, string, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
	parts := strings.Split(string(bytes), "|")
	if err != nil || len(parts) != 2 || !companionCursorID.MatchString(parts[1]) {
		return time.Time{}, "", apiError(http.StatusBadRequest, code, "Invalid pagination cursor")
	}
	clock, err := asTime(parts[0])
	if err != nil {
		return time.Time{}, "", apiError(http.StatusBadRequest, code, "Invalid pagination cursor")
	}
	return clock, parts[1], nil
}

func companionLimit(r *Request, fallback, maximum int) int {
	value := r.HTTP.URL.Query().Get("limit")
	if value == "" {
		return fallback
	}
	limit, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	if limit < 1 {
		return 1
	}
	if limit > maximum {
		return maximum
	}
	return limit
}
