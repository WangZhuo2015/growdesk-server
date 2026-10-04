//go:build mcp_oauth_integration

package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMCPOAuthLegacyGrantUpgradeIntegration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	config, err := LoadConfig()
	if err != nil {
		t.Fatalf("load isolated OAuth migration config: %v", err)
	}
	server, err := NewServer(ctx, config, nil)
	if err != nil {
		t.Fatalf("open isolated PostgreSQL runtime: %v", err)
	}
	defer server.Close()
	owner := seedPATTenant(t, ctx, server, "oauth_legacy_owner")
	foreign := seedPATTenant(t, ctx, server, "oauth_legacy_foreign")
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		for _, tenant := range []patTenant{owner, foreign} {
			if tenant.userID != "" {
				if cleanupErr := cleanupPATUser(cleanupCtx, server, tenant); cleanupErr != nil {
					t.Errorf("cleanup isolated legacy OAuth tenant: %v", cleanupErr)
				}
			}
		}
	}()

	grantID := newID()
	legacyClientID := "https://legacy.example/public-client"
	_, err = server.DB.Exec(ctx, `INSERT INTO native_go.oauth_grants
		(id,user_id,session_id,client_id,family_id,baby_id,audience,scopes,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY['baby:read']::text[],NOW()+INTERVAL '30 days')`,
		grantID, owner.userID, owner.sessionID, legacyClientID, owner.familyID, owner.babyID, server.mcpResourceAudience())
	if err != nil {
		t.Fatalf("create populated 0001-era OAuth grant: %v", err)
	}

	if err = ApplyNativeMigrationsThrough(ctx, "0004_oauth_lifecycle.sql"); err != nil {
		t.Fatalf("apply populated native 0001-0003 to 0004 upgrade: %v", err)
	}
	if err = ApplyNativeMigrations(ctx); err != nil {
		t.Fatalf("verify all native migration checksums after staged upgrade: %v", err)
	}
	server.RegisterBusinessHandlers()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()

	var sessionLive bool
	if err = server.DB.QueryRow(ctx, `SELECT revoked_at IS NULL AND absolute_expires_at>NOW() FROM device_sessions WHERE id=$1 AND user_id=$2`, owner.sessionID, owner.userID).Scan(&sessionLive); err != nil || !sessionLive {
		t.Fatalf("legacy grant's original app device session did not survive migration: live=%v err=%v", sessionLive, err)
	}

	listed, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/connections", owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if listed.status != http.StatusOK {
		t.Fatalf("owner connection inventory status %d: %#v", listed.status, listed.body)
	}
	entries, ok := listed.body["data"].([]any)
	if !ok {
		t.Fatalf("owner connection inventory is not a list: %#v", listed.body)
	}
	var found bool
	for _, raw := range entries {
		entry := obj(raw)
		if text(entry["id"]) != grantID {
			continue
		}
		found = true
		expiresAt, expiryErr := asTime(entry["expiresAt"])
		if expiryErr != nil || expiresAt.Before(time.Now().Add(29*24*time.Hour)) || expiresAt.After(time.Now().Add(31*24*time.Hour)) {
			t.Fatalf("owner legacy connection must expose its persisted expiration: expires=%v err=%v", entry["expiresAt"], expiryErr)
		}
		if entry["clientName"] != "Legacy OAuth client" || entry["clientId"] != legacyClientID {
			t.Fatalf("legacy connection did not use the safe fallback: %#v", entry)
		}
		for _, forbidden := range []string{"token", "tokenHash", "token_hash", "codeHash", "refreshToken", "secret", "password"} {
			if _, exists := entry[forbidden]; exists {
				t.Fatalf("legacy connection exposed credential field %q", forbidden)
			}
		}
	}
	if !found {
		t.Fatalf("populated 0001 OAuth grant disappeared from connection inventory: %#v", listed.body)
	}

	// An expired grant remains owner-manageable and exposes its actual expired
	// timestamp; clients must never guess expiry from the creation time.
	if _, err = server.DB.Exec(ctx, `UPDATE native_go.oauth_grants SET expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1 AND user_id=$2`, grantID, owner.userID); err != nil {
		t.Fatal(err)
	}
	expiredList, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/connections", owner.accessToken, nil)
	if err != nil || expiredList.status != http.StatusOK {
		t.Fatalf("read expired owner grant: status=%d err=%v", expiredList.status, err)
	}
	foundExpired := false
	for _, raw := range expiredList.body["data"].([]any) {
		entry := obj(raw)
		if text(entry["id"]) == grantID {
			expires, expiryErr := asTime(entry["expiresAt"])
			if expiryErr != nil || !expires.Before(time.Now()) {
				t.Fatalf("expired grant must expose a past timestamp: expires=%v err=%v", entry["expiresAt"], expiryErr)
			}
			foundExpired = true
		}
	}
	if !foundExpired {
		t.Fatal("expired grant disappeared from its owner's management inventory")
	}

	anonymous, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/connections/"+grantID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if anonymous.status != http.StatusUnauthorized {
		t.Fatalf("anonymous legacy grant deletion status %d", anonymous.status)
	}
	foreignList, err := patCall(httpServer.URL, http.MethodGet, "/api/v1/connections", foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if foreignList.status != http.StatusOK || len(foreignList.body["data"].([]any)) != 0 {
		t.Fatalf("another account saw the legacy grant: %#v", foreignList.body)
	}
	foreignDelete, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/connections/"+grantID, foreign.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if foreignDelete.status != http.StatusNotFound {
		t.Fatalf("another account revoked the legacy grant: status=%d body=%#v", foreignDelete.status, foreignDelete.body)
	}

	deleted, err := patCall(httpServer.URL, http.MethodDelete, "/api/v1/connections/"+grantID, owner.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.status != http.StatusOK {
		t.Fatalf("owner could not revoke the legacy grant after migration: status=%d body=%#v", deleted.status, deleted.body)
	}
	var revoked, deviceSessionStillLive bool
	if err = server.DB.QueryRow(ctx, `SELECT g.revoked_at IS NOT NULL,d.revoked_at IS NULL AND d.absolute_expires_at>NOW()
		FROM native_go.oauth_grants g JOIN device_sessions d ON d.id=g.session_id WHERE g.id=$1`, grantID).Scan(&revoked, &deviceSessionStillLive); err != nil || !revoked || !deviceSessionStillLive {
		t.Fatalf("legacy revoke or device-session preservation failed: revoked=%v session_live=%v err=%v", revoked, deviceSessionStillLive, err)
	}
}
