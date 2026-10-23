package backend

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestSyncCursorRoundTripAndBoundaries(t *testing.T){
	key:=strings.Repeat("test-key-",5)
	cursor:=syncCursor{Scope:"family",ScopeID:"test_family",Epoch:"test_epoch",Position:"9007199254740993",HighWater:"9007199254740994",Mode:"page",SchemaVersion:1}
	token,err:=signSyncCursor(cursor,key);if err!=nil { t.Fatal(err) }
	decoded,err:=verifySyncCursor(token,key,"family","test_family")
	if err!=nil || decoded!=cursor { t.Fatal(decoded,err) }
	parts:=strings.Split(token,".")
	raw,err:=base64.RawURLEncoding.DecodeString(parts[0]);if err!=nil { t.Fatal(err) }
	if !strings.HasPrefix(string(raw),`{"scope":"family","scopeId":`) { t.Fatal("signed property order changed") }
	for _,test:=range []struct{ raw,key,scope,id string }{
		{token,key,"family","other"},{token,key,"user","test_family"},
		{token,strings.Repeat("x",32),"family","test_family"},
		{parts[0]+"."+strings.Repeat("0",64),key,"family","test_family"},
		{token+".extra",key,"family","test_family"},{strings.Repeat("x",4097),key,"family","test_family"},
	}{ if _,err:=verifySyncCursor(test.raw,test.key,test.scope,test.id);err==nil { t.Fatal("invalid cursor accepted") } }
	for _,mutation:=range []func(*syncCursor){
		func(c *syncCursor){c.Position="-1"},func(c *syncCursor){c.HighWater="1"},
		func(c *syncCursor){c.HighWater="9223372036854775808"},func(c *syncCursor){c.Mode="other"},
		func(c *syncCursor){c.SchemaVersion=2},func(c *syncCursor){c.Epoch=""},
	}{ changed:=cursor;mutation(&changed);token,err:=signSyncCursor(changed,key);if err!=nil { t.Fatal(err) };if _,err=verifySyncCursor(token,key,"family","test_family");err==nil { t.Fatal("invalid signed cursor accepted") } }
}

func TestSyncSigningHasNoPublicDefault(t *testing.T){
	t.Setenv("SESSION_SECRET","")
	s:=Server{Config:Config{JWTSecret:strings.Repeat("local-test-key-",3)}}
	key,err:=s.syncSigningKey();if err!=nil || key!=s.Config.JWTSecret { t.Fatal("wrong configured fallback",err) }
	t.Setenv("SESSION_SECRET","short")
	if _,err=s.syncSigningKey();err==nil { t.Fatal("weak configured signing key accepted") }
	if _,err=signSyncCursor(syncCursor{},"short");err==nil { t.Fatal("weak signing key accepted") }
}
