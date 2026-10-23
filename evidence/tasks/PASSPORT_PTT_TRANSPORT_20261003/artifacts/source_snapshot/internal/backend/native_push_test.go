package backend

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/golang-jwt/jwt/v5"
)

func TestNativePushEndpointIsolation(t *testing.T) {
	c := Config{Environment: "test"}
	t.Setenv("GROWDESK_PUSH_TEST_ORIGIN", "http://127.0.0.1:25491")
	if _, err := nativePushEndpoint(c, "http://127.0.0.1:25491/test"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"https://fcm.googleapis.com/send/test", "http://127.0.0.1:25492/test", "http://localhost:25491/test", "http://test:password@127.0.0.1:25491/test", "http://127.0.0.1:25491/test#fragment"} {
		if _, err := nativePushEndpoint(c, raw); err == nil {
			t.Fatalf("preview accepted %q", raw)
		}
	}
	c.Environment = "production"
	for _, raw := range []string{"http://fcm.googleapis.com/send/test", "https://fcm.googleapis.com.evil.invalid/x", "https://127.0.0.1/x", "https://web.push.apple.com:8443/x", "https://metadata.google.internal/computeMetadata/v1"} {
		if _, err := nativePushEndpoint(c, raw); err == nil {
			t.Fatalf("production accepted %q", raw)
		}
	}
	for _, raw := range []string{"https://fcm.googleapis.com/fcm/send/test", "https://updates.push.services.mozilla.com/wpush/test", "https://test.web.push.apple.com/test"} {
		if _, err := nativePushEndpoint(c, raw); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{"127.0.0.1", "::1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::ffff:192.168.0.1", "fc00::1", "64:ff9b::a00:1", "198.18.1.1"} {
		if publicPushIP(netip.MustParseAddr(raw)) {
			t.Fatalf("accepted internal IP %s", raw)
		}
	}
}

func TestNativePushSubscriptionAndVAPID(t *testing.T) {
	private, public, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	if err = validateVAPID(public, private, "mailto:test@example.invalid"); err != nil {
		t.Fatal(err)
	}
	if err = validateVAPID(public, private, "file:///tmp/test"); err == nil {
		t.Fatal("invalid subject")
	}
	other, _, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	if err = validateVAPID(public, other, "mailto:test@example.invalid"); err == nil {
		t.Fatal("mismatched key pair")
	}
	auth := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	raw, _ := json.Marshal(webpush.Subscription{Endpoint: "https://fcm.googleapis.com/test", Keys: webpush.Keys{P256dh: public, Auth: auth}})
	if _, err = nativePushSubscription(string(raw)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"{}", "null", `{"keys":{"p256dh":"BAAA","auth":"AA"}}`, strings.Repeat("x", 8193)} {
		if _, err = nativePushSubscription(raw); err == nil {
			t.Fatal("invalid subscription")
		}
	}
}

func TestNativeAPNSTokenSignatureAndBoundedReuse(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}))
	now := time.Now().UTC().Truncate(time.Second)
	first, err := nativeAPNSToken("TESTTEAM01", "TESTKEY001", encoded, now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := nativeAPNSToken("TESTTEAM01", "TESTKEY001", encoded, now.Add(30*time.Minute))
	if err != nil || first != second {
		t.Fatal("token not reused", err)
	}
	next, err := nativeAPNSToken("TESTTEAM01", "TESTKEY001", encoded, now.Add(41*time.Minute))
	if err != nil || first == next {
		t.Fatal("token not renewed", err)
	}
	token, err := jwt.Parse(first, func(*jwt.Token) (any, error) { return &key.PublicKey, nil }, jwt.WithValidMethods([]string{"ES256"}), jwt.WithIssuer("TESTTEAM01"))
	if err != nil || !token.Valid {
		t.Fatal("signature failed", err)
	}
	if token.Header["kid"] != "TESTKEY001" || int64(token.Claims.(jwt.MapClaims)["iat"].(float64)) != now.Unix() {
		t.Fatal("wrong APNs claims")
	}
	if _, err = nativeAPNSToken("invalid", "TESTKEY001", encoded, now); err == nil {
		t.Fatal("invalid team accepted")
	}
	if _, err = nativeAPNSToken("TESTTEAM01", "TESTKEY001", "secret", now); err == nil {
		t.Fatal("invalid key accepted")
	}
}

func TestNativePushTransportCancellationAndRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/forbidden", 307)
			return
		}
		if r.URL.Path == "/forbidden" {
			t.Error("followed provider redirect")
			return
		}
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer server.Close()
	c := Config{Environment: "test"}
	client := nativePushClient(c)
	defer client.CloseIdleConnections()
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/redirect", nil)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 307 {
		t.Fatal("redirect was followed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	request, _ = http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/slow", nil)
	if _, err = client.Do(request); err == nil || ctx.Err() == nil {
		t.Fatal("request was not cancelled")
	}
}
