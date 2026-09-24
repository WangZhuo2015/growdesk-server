package backend

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Field order is the existing signed JSON protocol, not map iteration order.
type syncCursor struct {
	Scope string `json:"scope"`
	ScopeID string `json:"scopeId"`
	Epoch string `json:"epoch"`
	Position string `json:"position"`
	HighWater string `json:"highWater"`
	Mode string `json:"mode"`
	SchemaVersion int `json:"schemaVersion"`
}

func signSyncCursor(value syncCursor,secret string)(string,error){
	if len(secret)<32 { return "",errors.New("sync signing key must have at least 32 bytes") }
	raw,err:=jsonBytes(value)
	if err!=nil { return "",err }
	mac:=hmac.New(sha256.New,[]byte(secret)); _,_=mac.Write(raw)
	return base64.RawURLEncoding.EncodeToString(raw)+"."+hex.EncodeToString(mac.Sum(nil)),nil
}

func syncPosition(raw string)(int64,error){
	if raw=="" { return 0,apiError(400,"INVALID_SYNC_CURSOR","Missing cursor position") }
	for _,r:=range raw { if r<'0'||r>'9' { return 0,apiError(400,"INVALID_SYNC_CURSOR","Invalid cursor position") } }
	n,err:=strconv.ParseInt(raw,10,64)
	if err!=nil { return 0,apiError(400,"INVALID_SYNC_CURSOR","Cursor position exceeds the database range") }
	return n,nil
}

func verifySyncCursor(raw,secret,scope,id string)(syncCursor,error){
	var value syncCursor
	fail:=func()(syncCursor,error){ return value,apiError(400,"INVALID_SYNC_CURSOR","Invalid or mismatched sync cursor") }
	if len(raw)>4096 || len(secret)<32 { return fail() }
	parts:=strings.Split(raw,".")
	if len(parts)!=2 { return fail() }
	data,err:=base64.RawURLEncoding.DecodeString(parts[0]); if err!=nil { return fail() }
	signature,err:=hex.DecodeString(parts[1]); if err!=nil || len(signature)!=sha256.Size { return fail() }
	mac:=hmac.New(sha256.New,[]byte(secret)); _,_=mac.Write(data)
	if !hmac.Equal(signature,mac.Sum(nil)) { return fail() }
	if err=decodeJSON(data,&value); err!=nil { return fail() }
	if value.Scope!=scope || value.ScopeID!=id || value.Epoch=="" || (value.Mode!="page"&&value.Mode!="tail") || value.SchemaVersion!=1 { return fail() }
	position,err:=syncPosition(value.Position); if err!=nil { return fail() }
	high,err:=syncPosition(value.HighWater); if err!=nil || position>high { return fail() }
	return value,nil
}

func (s *Server) syncSigningKey()(string,error){
	key:=os.Getenv("SESSION_SECRET")
	if key=="" { key=s.Config.JWTSecret }
	if len(key)<32 { return "",errors.New("SESSION_SECRET must have at least 32 bytes") }
	// Do not copy the frozen reference's embedded public fallback secret.
	return key,nil
}

func (s *Server) registerSyncFeeds(){
	s.Register("getFamilyChanges",false,func(ctx context.Context,r *Request)(Result,error){ return s.changeFeed(ctx,r,"family",r.Params["familyId"]) })
	s.Register("getUserChanges",false,func(ctx context.Context,r *Request)(Result,error){ return s.changeFeed(ctx,r,"user",r.Principal.UserID) })
}

func (s *Server) changeFeed(ctx context.Context,r *Request,scope,id string)(Result,error){
	key,err:=s.syncSigningKey(); if err!=nil { return Result{},err }
	if scope=="family" {
		if _,err=familyRole(ctx,s.DB,r.Principal.UserID,id); err!=nil { return Result{},err }
		_,err=s.DB.Exec(ctx,`INSERT INTO family_sync_states(family_id,epoch,cursor,permission_version,created_at,updated_at)
			SELECT f.id,$3,0,1,NOW(),NOW() FROM families f JOIN family_members fm ON fm.family_id=f.id
			WHERE f.id=$1 AND fm.user_id=$2 AND f.deleted_at IS NULL AND fm.deleted_at IS NULL AND fm.status='active'
			ON CONFLICT(family_id) DO NOTHING`,id,r.Principal.UserID,newID())
	} else {
		_,err=s.DB.Exec(ctx,`INSERT INTO user_sync_states(user_id,epoch,cursor,created_at,updated_at)
			SELECT id,$2,0,NOW(),NOW() FROM users WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(user_id) DO NOTHING`,id,newID())
	}
	if err!=nil { return Result{},err }
	return s.readSnapshot(ctx,func(q Querier)(Result,error){
		if scope=="family" { if _,err:=familyRole(ctx,q,r.Principal.UserID,id); err!=nil { return Result{},err } }
		stateSQL:="SELECT to_jsonb(st) FROM user_sync_states st JOIN users u ON u.id=st.user_id WHERE st.user_id=$1 AND u.deleted_at IS NULL"
		if scope=="family" { stateSQL="SELECT to_jsonb(st) FROM family_sync_states st WHERE st.family_id=$1" }
		state,err:=one(ctx,q,stateSQL,id)
		if errors.Is(err,pgx.ErrNoRows) { return Result{},apiError(401,"UNAUTHORIZED","Sync identity is unavailable") }
		if err!=nil { return Result{},err }
		position,high:=int64(0),integer(state["cursor"])
		epoch:=text(state["epoch"])
		if raw:=r.HTTP.URL.Query().Get("cursor");raw!=""&&raw!="0" {
			decoded,err:=verifySyncCursor(raw,key,scope,id); if err!=nil { return Result{},err }
			if decoded.Epoch!=epoch { return Result{},apiError(410,"SYNC_RESET_REQUIRED","Sync epoch changed; reload a full snapshot") }
			position,_=syncPosition(decoded.Position)
			if decoded.Mode=="page" { high,_=syncPosition(decoded.HighWater) }
			if high>integer(state["cursor"]) || position>high { return Result{},apiError(410,"SYNC_RESET_REQUIRED","Sync cursor is beyond retained state") }
		}
		limit:=pageLimit(r)
		query:=`SELECT to_jsonb(c)||jsonb_build_object('__visible',true) FROM user_changes c WHERE user_id=$1 AND cursor>$2 AND cursor<=$3 ORDER BY cursor ASC LIMIT $4`
		args:=[]any{id,position,high,limit+1}
		if scope=="family" {
			query=`SELECT to_jsonb(c)||jsonb_build_object('__visible',
				CASE WHEN COALESCE(c.payload->>'babyId','')='' THEN true ELSE EXISTS(
					SELECT 1 FROM baby_members bm JOIN babies b ON b.id=bm.baby_id AND b.family_id=bm.family_id
					WHERE bm.user_id=$5 AND bm.family_id=$1 AND bm.baby_id=c.payload->>'babyId'
					AND bm.status='active' AND bm.deleted_at IS NULL AND b.deleted_at IS NULL
					AND bm.role IN ('admin','member','viewer')) END)
				FROM family_changes c WHERE family_id=$1 AND cursor>$2 AND cursor<=$3 ORDER BY cursor ASC LIMIT $4`
			args=append(args,r.Principal.UserID)
		}
		rows,err:=many(ctx,q,query,args...); if err!=nil { return Result{},err }
		hasMore:=len(rows)>limit
		if hasMore { rows=rows[:limit] }
		next,mode:=high,"tail"
		if len(rows)>0 && hasMore && integer(rows[len(rows)-1]["cursor"])<high { next,mode=integer(rows[len(rows)-1]["cursor"]),"page" }
		changes:=make([]Object,0,len(rows))
		for _,row:=range rows {
			if !boolean(row["__visible"]) { continue }
			op:="upsert"; if text(row["op"])=="delete" { op="delete" }
			payload:=obj(row["payload"]); if payload==nil { payload=Object{} }
			changes=append(changes,Object{"cursor":text(row["cursor"]),"entityType":row["entity_type"],"entityId":row["entity_id"],"version":text(row["version"]),"operation":op,"payload":payload})
		}
		token,err:=signSyncCursor(syncCursor{Scope:scope,ScopeID:id,Epoch:epoch,Position:strconv.FormatInt(next,10),HighWater:strconv.FormatInt(high,10),Mode:mode,SchemaVersion:1},key)
		if err!=nil { return Result{},err }
		return Result{Status:200,Body:Object{"scope":scope,"epoch":epoch,"changes":changes,"nextCursor":token,"highWater":strconv.FormatInt(high,10),"hasMore":hasMore}},nil
	})
}
