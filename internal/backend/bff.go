package backend

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var rawRefreshPattern=regexp.MustCompile(`^[a-f0-9]{64}$`)
func(s *Server)bffExchange(ctx context.Context,r *Request)(Result,error){
	secretHash:=text(r.Body["sessionSecretHash"])
	if text(r.Body["username"])!=""&&text(r.Body["password"])!=""{
		user,err:=s.verifyCredentials(ctx,strings.ToLower(strings.TrimSpace(text(r.Body["username"]))),text(r.Body["password"]));if err!=nil{return Result{},err}
		tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx);uid:=text(user["id"])
		if err=lockUser(ctx,tx,uid);err!=nil{return Result{},err}
		var unchanged bool;if err=tx.QueryRow(ctx,"SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND password_hash=$2 AND deleted_at IS NULL)",uid,text(user["password_hash"])).Scan(&unchanged);err!=nil{return Result{},err};if !unchanged{return Result{},apiError(401,"INVALID_CREDENTIALS","Invalid username or password")}
		label:=text(r.Body["deviceLabel"]);if label==""{label="Web Browser"};tokens,err:=s.createSession(ctx,tx,uid,label,"web");if err!=nil{return Result{},err}
		encrypted,err:=s.sealSession(tokens.RefreshToken,"bff:"+secretHash);if err!=nil{return Result{},err}
		_,err=tx.Exec(ctx,`INSERT INTO bff_sessions(id,session_secret_hash,user_id,session_id,encrypted_refresh_token,rotation_id,current_access_token,access_token_expires_at,idle_expires_at,absolute_expires_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT(session_secret_hash) DO UPDATE SET user_id=EXCLUDED.user_id,session_id=EXCLUDED.session_id,encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,rotation_id=EXCLUDED.rotation_id,current_access_token=EXCLUDED.current_access_token,access_token_expires_at=EXCLUDED.access_token_expires_at,idle_expires_at=EXCLUDED.idle_expires_at,absolute_expires_at=EXCLUDED.absolute_expires_at,revoked_at=NULL,updated_at=NOW()`,newID(),secretHash,uid,tokens.SessionID,encrypted,tokens.RotationID,tokens.AccessToken,time.Now().UTC().Add(600*time.Second),tokens.ExpiresAt,time.Now().UTC().Add(30*24*time.Hour));if err!=nil{return Result{},err};if err=tx.Commit(ctx);err!=nil{return Result{},err}
		return ok(Object{"accessToken":tokens.AccessToken,"expiresIn":600,"user":userDTO(user)})
	}
	pre,err:=one(ctx,s.DB,"SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1",secretHash);if errors.Is(err,pgx.ErrNoRows){return Result{},apiError(401,"BFF_SESSION_NOT_FOUND","BFF session does not exist or has expired")};if err!=nil{return Result{},err}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx);uid,sid:=text(pre["user_id"]),text(pre["session_id"])
	if supplied:=text(r.Body["userId"]);supplied!=""&&supplied!=uid{return Result{},apiError(401,"BFF_SESSION_USER_MISMATCH","BFF session user identity mismatch")}
	if err=lockUser(ctx,tx,uid);err!=nil{return Result{},err};session,err:=liveSession(ctx,tx,uid,sid);if err!=nil{if normalizedError(err).Status==401{return Result{},apiError(401,"BFF_SESSION_EXPIRED","BFF session has been revoked or expired")};return Result{},err}
	bff,err:=one(ctx,tx,"SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1 FOR UPDATE",secretHash);if err!=nil{return Result{},err}
	if text(bff["user_id"])!=uid||text(bff["session_id"])!=sid{return Result{},apiError(401,"BFF_SESSION_USER_MISMATCH","BFF session user identity mismatch")}
	idle,err:=asTime(bff["idle_expires_at"]);if err!=nil{return Result{},err};absolute,err:=asTime(bff["absolute_expires_at"]);if err!=nil{return Result{},err}
	if bff["revoked_at"]!=nil||!idle.After(time.Now())||!absolute.After(time.Now()){return Result{},apiError(401,"BFF_SESSION_EXPIRED","BFF session has been revoked or expired")}
	user,err:=one(ctx,tx,"SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL",uid);if errors.Is(err,pgx.ErrNoRows){return Result{},apiError(401,"USER_DELETED","User account is no longer active")};if err!=nil{return Result{},err}
	if token:=text(bff["current_access_token"]);token!=""&&bff["access_token_expires_at"]!=nil{expires,e:=asTime(bff["access_token_expires_at"]);if e!=nil{return Result{},e};if remaining:=int(time.Until(expires).Seconds());remaining>60{if err=tx.Commit(ctx);err!=nil{return Result{},err};return ok(Object{"accessToken":token,"expiresIn":remaining,"user":userDTO(user)})}}
	stored:=text(bff["encrypted_refresh_token"]);raw:=""
	if rawRefreshPattern.MatchString(stored){
		// Read-only compatibility with the reference's unfortunately plaintext
		// column. New credentials are always encrypted; never log this value.
		raw=stored
	}else{raw,err=s.openSession(stored,"bff:"+secretHash);if err!=nil{return Result{},apiError(503,"SESSION_KEY_UNAVAILABLE","Session cannot be decrypted with the configured key")}}
	result,commitError,err:=s.rotateLocked(ctx,tx,uid,session,raw,text(bff["rotation_id"]));if err!=nil{if commitError{if e:=tx.Commit(ctx);e!=nil{return Result{},e}};return Result{},err}
	encrypted,err:=s.sealSession(text(result["refreshToken"]),"bff:"+secretHash);if err!=nil{return Result{},err}
	newIdle:=time.Now().UTC().Add(7*24*time.Hour);if absolute.Before(newIdle){newIdle=absolute}
	_,err=tx.Exec(ctx,`UPDATE bff_sessions SET encrypted_refresh_token=$1,rotation_id=$2,current_access_token=$3,access_token_expires_at=$4,idle_expires_at=$5,updated_at=NOW() WHERE id=$6`,encrypted,text(result["rotationId"]),text(result["accessToken"]),time.Now().UTC().Add(600*time.Second),newIdle,text(bff["id"]));if err!=nil{return Result{},err};if err=tx.Commit(ctx);err!=nil{return Result{},err}
	return ok(Object{"accessToken":result["accessToken"],"expiresIn":result["expiresIn"],"user":userDTO(user)})
}

func(s *Server)bffRevoke(ctx context.Context,r *Request)(Result,error){
	hash:=text(r.Body["sessionSecretHash"]);pre,err:=one(ctx,s.DB,"SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1",hash);if errors.Is(err,pgx.ErrNoRows){return ok(Object{"success":true})};if err!=nil{return Result{},err}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx);uid:=text(pre["user_id"])
	if err=lockUser(ctx,tx,uid);err!=nil{return Result{},err}
	// Same order as refresh: user -> device -> BFF -> credentials. Re-check the
	// binding before revoking so a concurrent login cannot revoke another user.
	if _,err=one(ctx,tx,"SELECT to_jsonb(d) FROM device_sessions d WHERE id=$1 AND user_id=$2 FOR UPDATE",text(pre["session_id"]),uid);err!=nil{return Result{},err}
	row,err:=one(ctx,tx,"SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash=$1 FOR UPDATE",hash);if err!=nil{return Result{},err};if text(row["session_id"])!=text(pre["session_id"])||text(row["user_id"])!=uid{return Result{},apiError(409,"CONCURRENT_MODIFICATION","BFF binding changed; retry revocation")}
	if _,err=tx.Exec(ctx,"UPDATE bff_sessions SET revoked_at=NOW(),updated_at=NOW() WHERE id=$1",text(row["id"]));err!=nil{return Result{},err};if _,err=revokeSessionTx(ctx,tx,uid,text(row["session_id"]));err!=nil{return Result{},err};if err=tx.Commit(ctx);err!=nil{return Result{},err};return ok(Object{"success":true})
}
