package backend

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestDatabaseGuard(t *testing.T){
	valid:="postgresql://test_user:test_password@127.0.0.1:15432/test_go?sslmode=disable"
	if err:=ValidateDatabaseURL(valid,true);err!=nil{t.Fatal(err)}
	for _,url:=range []string{"", "file:prod.db", "postgres://test_user:test_password@127.0.0.1:15432/test_go", "postgresql://test_user:test_password@localhost:15432/test_go", "postgresql://postgres:password@127.0.0.1:5432/production", valid+"&host=remote", valid+"&sslmode=disable"}{if ValidateDatabaseURL(url,true)==nil{t.Fatalf("unsafe URL accepted: %q",url)}}
}
func TestProductionConfigValidation(t *testing.T){
	base := Config{
		Environment: "production",
		Address: "127.0.0.1:3180",
		JWTSecret: strings.Repeat("s", 32),
		SessionEncryptionKey: strings.Repeat("k", 32),
		DatabaseURL: "postgresql://growdesk:secure_pass@127.0.0.1:5432/growdesk",
		RedisURL: "redis://:redis_pass@127.0.0.1:6379/0",
	}
	if err := base.validateNativeRuntime(); err != nil {
		t.Fatalf("valid production config failed: %v", err)
	}
	superuser := base
	superuser.DatabaseURL = "postgresql://postgres:secure_pass@127.0.0.1:5432/growdesk"
	if err := superuser.validateNativeRuntime(); err == nil {
		t.Fatal("superuser DB role should be rejected in production")
	}
	legacyPort := base
	legacyPort.Address = "127.0.0.1:3088"
	if err := legacyPort.validateNativeRuntime(); err == nil {
		t.Fatal("legacy port 3088 should be rejected")
	}
	shortKey := base
	shortKey.JWTSecret = "short"
	if err := shortKey.validateNativeRuntime(); err == nil {
		t.Fatal("short JWTSecret should be rejected in production")
	}
}
func TestContractInventory(t *testing.T){c,err:=LoadContract();if err!=nil{t.Fatal(err)};if len(c.Routes)!=151{t.Fatalf("reference changed: %d operations",len(c.Routes))};r,p:=c.Match("GET","/api/v1/families/invites/preview");if r==nil||r.OperationID!="previewFamilyInvite"||len(p)!=0{t.Fatal("literal route did not take precedence")};r,p=c.Match("PATCH","/api/v1/babies/00000000-0000-4000-8000-000000000001/records/feeding/00000000-0000-4000-8000-000000000002");if r==nil||r.OperationID!="updateFeedingRecord"||p["babyId"]==""{t.Fatal("parameter route mismatch")}}
func TestSessionCipher(t *testing.T){s:=&Server{Config:Config{SessionEncryptionKey:strings.Repeat("x",40)}};encrypted,err:=s.sealSession("test_secret","test:one");if err!=nil{t.Fatal(err)};if strings.Contains(encrypted,"test_secret"){t.Fatal("plaintext escaped")};plain,err:=s.openSession(encrypted,"test:one");if err!=nil||plain!="test_secret"{t.Fatal("round trip failed")};if _,err=s.openSession(encrypted,"test:two");err==nil{t.Fatal("cross-purpose ciphertext accepted")};if _,err=s.openSession("go:v1:broken","test:one");err==nil{t.Fatal("malformed cipher accepted")}}
func TestAccessTokenClaims(t *testing.T){secret:=strings.Repeat("s",40);s:=&Server{Config:Config{JWTSecret:secret}};token,err:=s.signAccess("test_user","test_session",nil);if err!=nil{t.Fatal(err)};parsed,err:=jwt.Parse(token,func(t *jwt.Token)(any,error){return []byte(secret),nil},jwt.WithValidMethods([]string{"HS256"}),jwt.WithIssuer("growdesk-api"),jwt.WithAudience("baby-panel-api"));if err!=nil||!parsed.Valid{t.Fatal(err)};claims:=parsed.Claims.(jwt.MapClaims);if claims["typ"]!="at+jwt"||claims["sid"]!="test_session"||claims["deviceLabel"]!=nil{t.Fatal("reference claim shape differs")};expiry,_:=claims.GetExpirationTime();if time.Until(expiry.Time)>601*time.Second{t.Fatal("access token TTL differs")}}
func TestBcryptLegacyBytes(t *testing.T){s:=&Server{hashSlots:make(chan struct{},1)};password:=strings.Repeat("a",71)+"中";hash,err:=s.passwordHash(context.Background(),password,4);if err!=nil{t.Fatal(err)};valid,err:=s.checkPassword(context.Background(),password+"ignored",hash);if err!=nil||!valid{t.Fatal("bcryptjs byte truncation compatibility failed")}}
func TestOrderedHash(t *testing.T){h,err:=orderedHash("b",1,"a",nil);if err!=nil{t.Fatal(err)};if h!=hashText(`{"b":1,"a":null}`){t.Fatal("property order changed")};h2,_:=orderedHash("a",nil,"b",1);if h==h2{t.Fatal("ordered protocol unexpectedly sorted")}}
func TestJSONPrecision(t *testing.T){var data Object;if err:=decodeJSON([]byte(`{"cursor":9007199254740993,"empty":null}`),&data);err!=nil{t.Fatal(err)};raw,err:=jsonText(data);if err!=nil||!strings.Contains(raw,"9007199254740993"){t.Fatal("JSON number precision lost")};if decodeJSON([]byte(`{} {}`),&data)==nil{t.Fatal("trailing JSON value accepted")}}
