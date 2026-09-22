package backend

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

func lockUser(ctx context.Context,q Querier,user string)error{var cursor int64;err:=q.QueryRow(ctx,"SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE",user).Scan(&cursor);if errors.Is(err,pgx.ErrNoRows){return apiError(401,"USER_NOT_FOUND","User account not found")};return err}
func liveSession(ctx context.Context,q Querier,user,session string)(Object,error){
	row,err:=one(ctx,q,"SELECT to_jsonb(d) FROM device_sessions d WHERE id=$1 AND user_id=$2 FOR UPDATE",session,user);if errors.Is(err,pgx.ErrNoRows){return nil,apiError(401,"SESSION_NOT_FOUND","Session not found")};if err!=nil{return nil,err}
	expires,err:=asTime(row["absolute_expires_at"]);if err!=nil{return nil,err};if row["revoked_at"]!=nil||!expires.After(time.Now()){return nil,apiError(401,"SESSION_REVOKED","Session has expired or was revoked")}
	var active bool;if err=q.QueryRow(ctx,"SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL)",user).Scan(&active);err!=nil{return nil,err};if !active{return nil,apiError(401,"USER_NOT_FOUND","User account not found")};return row,nil
}

// rotateLocked requires UserSyncState -> DeviceSession locks. The boolean
// indicates that security revocation must be committed despite the API error.
func(s *Server)rotateLocked(ctx context.Context,tx pgx.Tx,user string,session Object,raw,rotation string)(Object,bool,error){
	hash:=hashText(raw)
	cred,err:=one(ctx,tx,"SELECT to_jsonb(c) FROM refresh_credentials c WHERE token_hash=$1 AND user_id=$2 AND session_id=$3 FOR UPDATE",hash,user,text(session["id"]));if errors.Is(err,pgx.ErrNoRows){return nil,false,apiError(401,"INVALID_REFRESH_TOKEN","Refresh token is invalid or does not exist")};if err!=nil{return nil,false,err}
	if cred["revoked_at"]!=nil{return nil,false,apiError(401,"REFRESH_TOKEN_REVOKED","Refresh token has been revoked")}
	key:="replay:refresh:"+hash+":"+rotation
	if cred["used_at"]!=nil{
		used,e:=asTime(cred["used_at"]);if e!=nil{return nil,false,e}
		if text(cred["rotation_id"])==rotation&&time.Since(used)<=60*time.Second{
			ciphertext,e:=s.Redis.Get(ctx,key).Result();if errors.Is(e,redis.Nil){return nil,false,apiError(401,"REPLAY_EXPIRED","Replay window has expired; please authenticate again")};if e!=nil{return nil,false,apiError(503,"DEPENDENCY_UNAVAILABLE","Refresh replay store unavailable")}
			plain,e:=s.openSession(ciphertext,key);if e!=nil{return nil,false,apiError(401,"REPLAY_EXPIRED","Replay window has expired; please authenticate again")};var result Object;if e=decodeJSON([]byte(plain),&result);e!=nil{return nil,false,e};return result,false,nil
		}
		if _,err:=revokeSessionTx(ctx,tx,user,text(session["id"]));err!=nil{return nil,false,err};return nil,true,apiError(409,"REFRESH_REUSE_DETECTED","Refresh token reuse detected; device session has been revoked")
	}
	expires,err:=asTime(cred["expires_at"]);if err!=nil{return nil,false,err};if !expires.After(time.Now()){return nil,false,apiError(401,"REFRESH_TOKEN_EXPIRED","Refresh token has expired")}
	newRaw:=randomHex(32);newHash:=hashText(newRaw);deadline:=time.Now().UTC().Add(7*24*time.Hour);absolute,err:=asTime(session["absolute_expires_at"]);if err!=nil{return nil,false,err};if absolute.Before(deadline){deadline=absolute}
	if _,err=tx.Exec(ctx,"UPDATE refresh_credentials SET used_at=NOW(),rotation_id=$2,replaced_by_id=$3 WHERE token_hash=$1",hash,rotation,newHash);err!=nil{return nil,false,err}
	if _,err=tx.Exec(ctx,`INSERT INTO refresh_credentials(token_hash,session_id,user_id,parent_id,rotation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,newHash,text(session["id"]),user,hash,rotation,deadline);err!=nil{return nil,false,err}
	if _,err=tx.Exec(ctx,"UPDATE device_sessions SET last_seen_at=NOW() WHERE id=$1",text(session["id"]));err!=nil{return nil,false,err}
	access,err:=s.signAccess(user,text(session["id"]),session["device_label"]);if err!=nil{return nil,false,err}
	result:=Object{"accessToken":access,"refreshToken":newRaw,"expiresIn":600,"rotationId":rotation}
	plain,err:=jsonText(result);if err!=nil{return nil,false,err};encrypted,err:=s.sealSession(plain,key);if err!=nil{return nil,false,err}
	// Write replay recovery before committing. A rollback leaves only an
	// inaccessible cache value; no credential is marked used until COMMIT.
	if err=s.Redis.Set(ctx,key,encrypted,60*time.Second).Err();err!=nil{return nil,false,apiError(503,"DEPENDENCY_UNAVAILABLE","Refresh replay store unavailable")}
	return result,false,nil
}

func(s *Server)refresh(ctx context.Context,r *Request)(Result,error){
	raw,rotation:=text(r.Body["refreshToken"]),text(r.Body["rotationId"])
	cred,err:=one(ctx,s.DB,"SELECT to_jsonb(c) FROM refresh_credentials c WHERE token_hash=$1",hashText(raw));if errors.Is(err,pgx.ErrNoRows){return Result{},apiError(401,"INVALID_REFRESH_TOKEN","Refresh token is invalid or does not exist")};if err!=nil{return Result{},err}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx);uid,sid:=text(cred["user_id"]),text(cred["session_id"])
	if err=lockUser(ctx,tx,uid);err!=nil{return Result{},err};session,err:=liveSession(ctx,tx,uid,sid);if err!=nil{return Result{},err}
	result,commitError,err:=s.rotateLocked(ctx,tx,uid,session,raw,rotation);if err!=nil&&!commitError{return Result{},err}
	if e:=tx.Commit(ctx);e!=nil{return Result{},e};if err!=nil{return Result{},err};return ok(result)
}
