package backend

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
)

func nativePushPlatformConfigured(platform string) bool {
	switch platform {
	case "web":
		return os.Getenv("VAPID_PUBLIC_KEY") != "" && os.Getenv("VAPID_PRIVATE_KEY") != "" && os.Getenv("VAPID_SUBJECT") != ""
	case "ios":
		return os.Getenv("APNS_TEAM_ID") != "" && os.Getenv("APNS_KEY_ID") != "" && os.Getenv("APNS_TOPIC") != "" && os.Getenv("APNS_PRIVATE_KEY") != ""
	default:
		return false
	}
}
func nativePushConfigured() bool {
	return nativePushPlatformConfigured("web") || nativePushPlatformConfigured("ios")
}

// No proxy or redirects: neither stored device URLs nor environment proxy
// settings may turn a delivery into an arbitrary internal-network request.
// Preview runtimes can contact only their explicit loopback test origin.
func nativePushEndpoint(c Config, raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" || len(raw) > 4096 {
		return nil, invalid("Invalid push endpoint")
	}
	if c.Environment == "test" || c.Environment == "development" {
		origin, e := url.Parse(os.Getenv("GROWDESK_PUSH_TEST_ORIGIN"))
		if e != nil || origin.Scheme != "http" || origin.Hostname() != "127.0.0.1" || origin.Port() == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
			return nil, apiError(503, "PUSH_NOT_CONFIGURED", "Preview requires an owned loopback push fixture")
		}
		port, e := strconv.Atoi(origin.Port())
		if e != nil || port < 1024 || port > 65535 || port == 3088 || port == 3089 {
			return nil, invalid("Invalid push test port")
		}
		if u.Scheme != origin.Scheme || u.Host != origin.Host {
			return nil, invalid("Push endpoint is outside the owned fixture")
		}
		return u, nil
	}
	if c.Environment != "production" || u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") {
		return nil, invalid("Push endpoint requires HTTPS")
	}
	host := strings.ToLower(u.Hostname())
	permitted := host == "fcm.googleapis.com" || host == "updates.push.services.mozilla.com" || strings.HasSuffix(host, ".push.services.mozilla.com") || host == "web.push.apple.com" || strings.HasSuffix(host, ".web.push.apple.com") || host == "api.push.apple.com" || host == "api.sandbox.push.apple.com"
	if !permitted {
		return nil, invalid("Unsupported push service host")
	}
	return u, nil
}

func nativePushClient(c Config) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if c.Environment != "production" {
			return dialer.DialContext(ctx, network, address)
		}
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, errors.New("push host has no addresses")
		}
		for _, ip := range ips {
			if !publicPushIP(ip) {
				return nil, errors.New("push host resolved to a non-public address")
			}
		}
		var last error
		for _, ip := range ips {
			conn, e := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if e == nil {
				return conn, nil
			}
			last = e
		}
		return nil, last
	}
	return &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{
		Proxy: nil, DialContext: dial, ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 5 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second, IdleConnTimeout: 60 * time.Second, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 8,
	}}
}
func publicPushIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "64:ff9b::/96"} {
		if netip.MustParsePrefix(prefix).Contains(ip) {
			return false
		}
	}
	return true
}

func nativePushSubscription(raw string) (*webpush.Subscription, error) {
	if len(raw) > 8192 {
		return nil, invalid("Push subscription is too large")
	}
	var sub webpush.Subscription
	if err := json.Unmarshal([]byte(raw), &sub); err != nil {
		return nil, invalid("Invalid Web Push subscription")
	}
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(sub.Keys.P256dh, "="))
	if err != nil {
		return nil, invalid("Invalid push public key")
	}
	if _, err = ecdh.P256().NewPublicKey(key); err != nil {
		return nil, invalid("Invalid push public key")
	}
	auth, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(sub.Keys.Auth, "="))
	if err != nil || len(auth) != 16 {
		return nil, invalid("Invalid push authentication secret")
	}
	return &sub, nil
}
func validateVAPID(public, private, subject string) error {
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(private, "="))
	if err != nil || len(key) != 32 {
		return invalid("Invalid VAPID private key")
	}
	scalar, err := ecdh.P256().NewPrivateKey(key)
	if err != nil {
		return invalid("Invalid VAPID private key")
	}
	pub, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(public, "="))
	if err != nil || !bytes.Equal(pub, scalar.PublicKey().Bytes()) {
		return invalid("VAPID key pair does not match")
	}
	u, err := url.Parse(subject)
	if err != nil || !((u.Scheme == "mailto" && u.Opaque != "") || (u.Scheme == "https" && u.Hostname() != "" && u.User == nil)) {
		return invalid("Invalid VAPID subject")
	}
	return nil
}

type apnsTokenCache struct {
	sync.Mutex
	key     [32]byte
	token   string
	created time.Time
}

var nativeAPNSTokens apnsTokenCache
var apnsIdentifier = regexp.MustCompile(`^[A-Za-z0-9]{10}$`)
var apnsDeviceToken = regexp.MustCompile(`^[A-Fa-f0-9]{64,200}$`)

func nativeAPNSToken(team, keyID, private string, now time.Time) (string, error) {
	fingerprint := sha256.Sum256([]byte(team + "\x00" + keyID + "\x00" + private))
	nativeAPNSTokens.Lock()
	defer nativeAPNSTokens.Unlock()
	if nativeAPNSTokens.key == fingerprint && nativeAPNSTokens.token != "" && !now.Before(nativeAPNSTokens.created) && now.Sub(nativeAPNSTokens.created) < 40*time.Minute {
		return nativeAPNSTokens.token, nil
	}
	if !apnsIdentifier.MatchString(team) || !apnsIdentifier.MatchString(keyID) {
		return "", invalid("Invalid APNs signing identifiers")
	}
	block, rest := pem.Decode([]byte(private))
	if block == nil || len(bytes.TrimSpace(rest)) != 0 {
		return "", invalid("Invalid APNs private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", invalid("Invalid APNs PKCS8 key")
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return "", invalid("APNs requires a P-256 key")
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": team, "iat": now.Unix()})
	token.Header["kid"] = keyID
	signed, err := token.SignedString(key)
	if err != nil {
		return "", err
	}
	nativeAPNSTokens.key, nativeAPNSTokens.token, nativeAPNSTokens.created = fingerprint, signed, now
	return signed, nil
}

// Delivery is at-least-once. Stable notification identity supports downstream
// deduplication; a response never authorizes sending to a new device owner.
func (s *Server) executeNativePush(ctx context.Context, lease nativeTaskLease) error {
	var device, notification Object
	_, err := s.readSnapshot(ctx, func(q Querier) (Result, error) {
		if err := nativeTaskOwner(ctx, q, lease.Input, false); err != nil {
			return Result{}, err
		}
		var err error
		device, err = one(ctx, q, `SELECT to_jsonb(d) FROM push_devices d WHERE id=$1 AND user_id=$2`, lease.Input.PushDeviceID, lease.Input.UserID)
		if err != nil {
			return Result{}, err
		}
		notification, err = one(ctx, q, `SELECT to_jsonb(n) FROM notifications n WHERE id=$1 AND user_id=$2`, lease.Input.NotificationID, lease.Input.UserID)
		return Result{}, err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apiError(410, "PUSH_SUBSCRIPTION_GONE", "Notification or subscription was removed")
	}
	if err != nil {
		return err
	}
	platform := text(device["platform"])
	if !nativePushPlatformConfigured(platform) {
		return apiError(503, "PUSH_NOT_CONFIGURED", "Push adapter is not configured")
	}
	if err = s.renewNativeLease(ctx, lease); err != nil {
		return err
	}
	var response *http.Response
	client := s.PushHTTP
	if client == nil {
		return errors.New("native push client is not initialized")
	}
	payload := Object{"title": notification["title"], "body": notification["body"], "data": notification["data"], "tag": lease.Input.NotificationID}
	switch platform {
	case "web":
		sub, e := nativePushSubscription(text(device["token"]))
		if e != nil {
			return e
		}
		if _, e = nativePushEndpoint(s.Config, sub.Endpoint); e != nil {
			return e
		}
		public, private, subject := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"), os.Getenv("VAPID_SUBJECT")
		if e = validateVAPID(public, private, subject); e != nil {
			return e
		}
		raw, e := jsonBytes(payload)
		if e != nil {
			return e
		}
		if len(raw) > 3072 {
			return invalid("Push payload exceeds budget")
		}
		digest := sha256.Sum256([]byte(lease.Input.NotificationID))
		response, err = webpush.SendNotificationWithContext(ctx, raw, sub, &webpush.Options{HTTPClient: client, Subscriber: subject, VAPIDPublicKey: public, VAPIDPrivateKey: private, TTL: 300, Topic: hex.EncodeToString(digest[:16])})
	case "ios":
		token := text(device["token"])
		if !apnsDeviceToken.MatchString(token) || len(token)%2 != 0 {
			return invalid("Invalid APNs device token")
		}
		origin := "https://api.push.apple.com"
		switch text(device["environment"]) {
		case "sandbox", "development":
			origin = "https://api.sandbox.push.apple.com"
		case "production":
		default:
			return invalid("Invalid APNs environment")
		}
		if s.Config.Environment != "production" {
			origin = os.Getenv("GROWDESK_PUSH_TEST_ORIGIN")
		}
		endpoint, e := nativePushEndpoint(s.Config, strings.TrimRight(origin, "/")+"/3/device/"+token)
		if e != nil {
			return e
		}
		signed, e := nativeAPNSToken(os.Getenv("APNS_TEAM_ID"), os.Getenv("APNS_KEY_ID"), os.Getenv("APNS_PRIVATE_KEY"), time.Now())
		if e != nil {
			return e
		}
		raw, e := jsonBytes(Object{"aps": Object{"alert": Object{"title": notification["title"], "body": notification["body"]}, "sound": "default"}, "notificationId": lease.Input.NotificationID, "data": notification["data"]})
		if e != nil {
			return e
		}
		if len(raw) > 4096 {
			return invalid("APNs payload exceeds budget")
		}
		request, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(raw))
		if e != nil {
			return e
		}
		request.Header.Set("authorization", "bearer "+signed)
		request.Header.Set("apns-topic", os.Getenv("APNS_TOPIC"))
		request.Header.Set("apns-push-type", "alert")
		request.Header.Set("apns-priority", "10")
		request.Header.Set("apns-id", lease.Input.NotificationID)
		request.Header.Set("apns-collapse-id", lease.Input.NotificationID)
		request.Header.Set("content-type", "application/json")
		response, err = client.Do(request)
	default:
		return invalid("Unsupported push platform")
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return providerFailure("PUSH_DELIVERY_FAILED", "Push transport failed", true)
	}
	defer response.Body.Close()
	_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return providerFailure("PUSH_DELIVERY_FAILED", "Push response interrupted", true)
	}
	gone := response.StatusCode == 404 || response.StatusCode == 410
	if !gone && (response.StatusCode < 200 || response.StatusCode >= 300) {
		return providerFailure("PUSH_SERVICE_REJECTED", "Push service rejected delivery", response.StatusCode == 408 || response.StatusCode == 429 || response.StatusCode >= 500)
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = lockSubmissionScope(ctx, tx, lease.Input); err != nil {
		return err
	}
	if err = guardNativeLease(ctx, tx, lease); err != nil {
		return err
	}
	if gone {
		// A concurrent re-registration must survive an old endpoint's 410.
		_, err = tx.Exec(ctx, `DELETE FROM push_devices WHERE id=$1 AND user_id=$2 AND token=$3 AND updated_at=$4`, device["id"], lease.Input.UserID, device["token"], device["updated_at"])
		if err != nil {
			return err
		}
		if err = terminalNativeTask(ctx, tx, lease, "succeeded", Object{"notificationId": lease.Input.NotificationID, "platform": platform, "delivered": false, "subscriptionGone": true}); err != nil {
			return err
		}
	} else if err = terminalNativeTask(ctx, tx, lease, "succeeded", Object{"notificationId": lease.Input.NotificationID, "platform": platform, "delivered": true}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
