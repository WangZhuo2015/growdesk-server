package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeProviderStreamHasBoundedCompletion(t *testing.T) {
	stream := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n"
	var deltas strings.Builder
	result, err := readNativeAIStream(strings.NewReader(stream), func(text string) error { deltas.WriteString(text); return nil })
	if err != nil || result.Text != "hello world" || deltas.String() != result.Text { t.Fatal(result, err) }
	for _, input := range []string{
		"data: {broken}\n\n", "data: {\"choices\":[]}\n\n",
		"data: " + strings.Repeat("x", 256*1024) + "\n\n",
	} {
		if _, err := readNativeAIStream(strings.NewReader(input), nil); err == nil { t.Fatal("invalid stream accepted") }
	}
	cancelled := errors.New("test persistence cancellation")
	_, err = readNativeAIStream(strings.NewReader(stream), func(string) error { return cancelled })
	if !errors.Is(err, cancelled) { t.Fatal("delta callback failure swallowed", err) }
}

func TestNativeProviderContextAndRedirectBoundary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/private", http.StatusTemporaryRedirect)
			return
		}
		if r.URL.Path == "/private" { t.Error("provider redirect was followed") }
		select { case <-r.Context().Done(): case <-time.After(time.Second): }
	}))
	defer server.Close()
	config := nativeProviderConfig{Mode: "openai-compatible", Endpoint: server.URL + "/slow", APIKey: "test_fake_key", Model: "test_model", Timeout: 100*time.Millisecond}
	_, err := callNativeAI(context.Background(), config, "test_session", "test_baby", "test_message", nil, nil)
	var providerErr *nativeProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != "AI_PROVIDER_TIMEOUT" { t.Fatal("timeout was not preserved", err) }
	config.Endpoint = server.URL + "/redirect"
	_, err = callNativeAI(context.Background(), config, "test_session", "", "test", nil, nil)
	if !errors.As(err, &providerErr) || providerErr.Code != "AI_PROVIDER_HTTP_ERROR" { t.Fatal("redirect accepted", err) }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = callNativeAI(ctx, nativeProviderConfig{Mode: "fixture", Fixture: "test"}, "", "", "test", nil, nil)
	if !errors.Is(err, context.Canceled) { t.Fatal("cancelled fixture still ran", err) }
}

func TestNativeProviderRejectsInvalidProposals(t *testing.T) {
	for _, text := range []string{
		`{"text":"x","actions":[{"actionId":"bad","entityType":"feeding","operation":"create","summary":"x","payload":{}}]}`,
		`{"text":"x","actions":{}}`,
		strings.Repeat("x", maxProviderResponse+1),
	} {
		if _, err := parseNativeAssistant(text); err == nil { t.Fatal("invalid proposal accepted") }
	}
	value, err := parseNativeAssistant(`{"text":"test","actions":[]}`)
	if err != nil || value.Text != "test" || len(value.Actions) != 0 { t.Fatal(value, err) }
}

func TestNativeAttachmentVerificationCleansErrorBuffers(t *testing.T) {
	temporary := t.TempDir()
	t.Setenv("TMPDIR", temporary)
	bytes := []byte("test_private_attachment")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") { t.Error("SDK did not sign object request") }
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(bytes)
	}))
	defer server.Close()
	t.Setenv("S3_ENDPOINT", server.URL)
	t.Setenv("S3_BUCKET", "test-attachment-buffer")
	t.Setenv("S3_REGION", "us-east-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "test_buffer_key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test_buffer_secret_not_real")
	t.Setenv("AWS_SESSION_TOKEN", "")
	store, err := newNativeObjectStore(Config{Environment: "test"})
	if err != nil { t.Fatal(err) }
	defer store.Close()
	wrong := strings.Repeat("0", 64)
	if file, err := store.verifiedFile(context.Background(), "test/object", int64(len(bytes)), wrong); err == nil || file != nil { t.Fatal("corrupt object accepted") }
	files, err := filepath.Glob(filepath.Join(temporary, "growdesk-attachment-*"))
	if err != nil || len(files) != 0 { t.Fatal("failed verification leaked its buffer", files, err) }
	digest := sha256.Sum256(bytes)
	file, err := store.verifiedFile(context.Background(), "test/object", int64(len(bytes)), hex.EncodeToString(digest[:]))
	if err != nil { t.Fatal(err) }
	defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
	info, err := file.Stat()
	if err != nil || info.Mode().Perm() != 0600 { t.Fatal("unsafe buffer permissions", err) }
	actual, err := io.ReadAll(file)
	if err != nil || string(actual) != string(bytes) { t.Fatal("verified data mismatch", err) }
	t.Setenv("S3_ENDPOINT", "https://example.com")
	if _, err := newNativeObjectStore(Config{Environment: "test"}); err == nil { t.Fatal("test object store accepted remote host") }
}

func TestLegacyAttachmentAndEventInputBounds(t *testing.T) {
	if path, err := nativeLegacyUploadPath("/uploads/test_image.png"); err != nil || path != "public/uploads/test_image.png" { t.Fatal(path, err) }
	for _, path := range []string{"/uploads/../secret", "/uploads/a%2Fb", "/uploads/a?x", "/uploads//x", "/uploads/", "/other/test.png"} {
		if _, err := nativeLegacyUploadPath(path); err == nil { t.Fatal("unsafe legacy path accepted", path) }
	}
	for _, raw := range []string{"-1", "1.5", "9223372036854775808", "1x"} {
		if _, _, err := aiEventCursor(raw); err == nil { t.Fatal("bad event cursor accepted", raw) }
	}
	if n, present, err := aiEventCursor(" 9007199254740993 "); err != nil || !present || n != 9007199254740993 { t.Fatal(n, present, err) }
	if _, err := attachmentDigest(strings.Repeat("g", 64)); err == nil { t.Fatal("nonhex digest accepted") }
}
