package backend

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func(s *Server)signAccess(user,session string,label any)(string,error){
	now:=time.Now().Unix()
	claims:=jwt.MapClaims{"sub":user,"sid":session,"deviceLabel":label,"typ":"at+jwt","iss":"growdesk-api","aud":"baby-panel-api","iat":now,"exp":now+600,"jti":newID()}
	return jwt.NewWithClaims(jwt.SigningMethodHS256,claims).SignedString([]byte(s.Config.JWTSecret))
}

func(s *Server)authenticate(ctx context.Context,r *http.Request)(Principal,error){
	header:=r.Header.Get("Authorization");if !strings.HasPrefix(header,"Bearer "){return Principal{},apiError(401,"UNAUTHORIZED","Missing or malformed Authorization header")}
	claims:=jwt.MapClaims{}
	token,err:=jwt.ParseWithClaims(strings.TrimSpace(strings.TrimPrefix(header,"Bearer ")),claims,func(token *jwt.Token)(any,error){return []byte(s.Config.JWTSecret),nil},jwt.WithValidMethods([]string{"HS256"}),jwt.WithIssuer("growdesk-api"),jwt.WithAudience("baby-panel-api"),jwt.WithExpirationRequired())
	if err!=nil||!token.Valid||text(claims["typ"])!="at+jwt"||text(claims["sub"])==""||text(claims["sid"])==""{return Principal{},apiError(401,"UNAUTHORIZED","Invalid or expired access token")}
	p:=Principal{UserID:text(claims["sub"]),SessionID:text(claims["sid"])}
	err=s.DB.QueryRow(ctx,`SELECT u.username,d.device_label FROM device_sessions d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.absolute_expires_at>NOW() AND u.deleted_at IS NULL`,p.SessionID,p.UserID).Scan(&p.Username,&p.DeviceLabel)
	if errors.Is(err,pgx.ErrNoRows){return Principal{},apiError(401,"SESSION_REVOKED","Session has expired or was revoked")};if err!=nil{return Principal{},err};return p,nil
}

// bcryptjs truncates UTF-8 password bytes at 72. Preserve legacy verification
// semantics, including passwords whose 72nd byte splits a multibyte character.
func bcryptPassword(password string)[]byte{b:=[]byte(password);if len(b)>72{return b[:72]};return b}
func(s *Server)passwordHash(ctx context.Context,password string,cost int)(string,error){
	select{case s.hashSlots<-struct{}{}:defer func(){<-s.hashSlots}();case <-ctx.Done():return "",ctx.Err()}
	b,err:=bcrypt.GenerateFromPassword(bcryptPassword(password),cost);return string(b),err
}
func(s *Server)checkPassword(ctx context.Context,password,hash string)(bool,error){
	select{case s.hashSlots<-struct{}{}:defer func(){<-s.hashSlots}();case <-ctx.Done():return false,ctx.Err()}
	if !(strings.HasPrefix(hash,"$2a$")||strings.HasPrefix(hash,"$2b$")||strings.HasPrefix(hash,"$2y$")){return false,nil}
	return bcrypt.CompareHashAndPassword([]byte(hash),bcryptPassword(password))==nil,nil
}
func userDTO(row Object)Object{return Object{"id":row["id"],"username":row["username"],"displayName":row["display_name"],"createdAt":isoValue(row["created_at"]),"updatedAt":isoValue(row["updated_at"])}}
func inferPlatform(label string)string{label=strings.ToLower(label);for _,entry:=range []struct{kind string;words []string}{{"ios",[]string{"ios","iphone","ipad"}},{"web",[]string{"web","chrome","safari","firefox"}},{"macos",[]string{"mac"}},{"android",[]string{"android"}}}{for _,word:=range entry.words{if strings.Contains(label,word){return entry.kind}}};return "unknown"}

type sessionTokens struct{SessionID,RefreshToken,RotationID,AccessToken string;ExpiresAt time.Time}
func(s *Server)createSession(ctx context.Context,q Querier,user,label,platform string)(sessionTokens,error){
	x:=sessionTokens{SessionID:newID(),RefreshToken:randomHex(32),RotationID:newID(),ExpiresAt:time.Now().UTC().Add(7*24*time.Hour)}
	if label==""{label="Web/Default"};if platform==""{platform=inferPlatform(label)}
	_,err:=q.Exec(ctx,`INSERT INTO device_sessions(id,user_id,device_label,platform,absolute_expires_at) VALUES($1,$2,$3,$4,$5)`,x.SessionID,user,label,platform,time.Now().UTC().Add(30*24*time.Hour));if err!=nil{return x,err}
	_,err=q.Exec(ctx,`INSERT INTO refresh_credentials(token_hash,session_id,user_id,rotation_id,expires_at) VALUES($1,$2,$3,$4,$5)`,hashText(x.RefreshToken),x.SessionID,user,x.RotationID,x.ExpiresAt);if err!=nil{return x,err}
	x.AccessToken,err=s.signAccess(user,x.SessionID,label);return x,err
}

func(s *Server)registerAuth(){
	s.Register("register",true,s.registerAccount);s.Register("login",true,s.login)
	s.Register("refreshSession",true,s.refresh);s.Register("exchangeBffSession",true,s.bffExchange);s.Register("revokeBffSession",true,s.bffRevoke)
	s.Register("logout",false,s.logout);s.Register("listSessions",false,s.listSessions);s.Register("revokeSession",false,s.revokeSessionHandler)
	s.Register("getCurrentUser",false,s.me);s.Register("changePassword",false,s.changePassword)
	s.Register("regenerateRecoveryCodes",false,s.regenerateCodes);s.Register("recoverPassword",true,s.recoverPassword)
}

func(s *Server)registerAccount(ctx context.Context,r *Request)(Result,error){
	name,password,display:=text(r.Body["username"]),text(r.Body["password"]),text(r.Body["displayName"])
	var collision bool;if err:=s.DB.QueryRow(ctx,"SELECT EXISTS(SELECT 1 FROM users WHERE username=$1)",name).Scan(&collision);err!=nil{return Result{},err};if collision{return Result{},apiError(409,"USERNAME_EXISTS","Username '"+name+"' is already taken")}
	hash,err:=s.passwordHash(ctx,password,10);if err!=nil{return Result{},err}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx)
	userID,familyID:=newID(),newID()
	user,err:=one(ctx,tx,`INSERT INTO users AS u(id,username,password_hash,display_name,updated_at) VALUES($1,$2,$3,$4,NOW()) RETURNING to_jsonb(u)`,userID,name,hash,display);if err!=nil{if normalizedError(err).Status==409{return Result{},apiError(409,"USERNAME_EXISTS","Username '"+name+"' is already taken")};return Result{},err}
	for _,cmd:=range []struct{sql string;args []any}{
		{`INSERT INTO user_sync_states(user_id,epoch,updated_at) VALUES($1,$2,NOW())`,[]any{userID,newID()}},
		{`INSERT INTO families(id,name,timezone,updated_at) VALUES($1,$2,'Asia/Shanghai',NOW())`,[]any{familyID,display+"的家庭"}},
		{`INSERT INTO family_sync_states(family_id,epoch,updated_at) VALUES($1,$2,NOW())`,[]any{familyID,newID()}},
		{`INSERT INTO family_members(id,family_id,user_id,role,status,updated_at) VALUES($1,$2,$3,'admin','active',NOW())`,[]any{newID(),familyID,userID}},
	}{if _,err=tx.Exec(ctx,cmd.sql,cmd.args...);err!=nil{return Result{},err}}
	tokens,err:=s.createSession(ctx,tx,userID,text(r.Body["deviceLabel"]),"");if err!=nil{return Result{},err}
	if err=tx.Commit(ctx);err!=nil{return Result{},err}
	return created(Object{"accessToken":tokens.AccessToken,"refreshToken":tokens.RefreshToken,"expiresIn":600,"sessionId":tokens.SessionID,"user":userDTO(user)})
}

const dummyBcrypt = "$2a$12$e8qW7M11jAeVyXz0KkL7mOSX92/wP538fCg/yK04V5gGkLd/d091W"
func(s *Server)verifyCredentials(ctx context.Context,username,password string)(Object,error){
	user,err:=one(ctx,s.DB,"SELECT to_jsonb(u) FROM users u WHERE username=$1",username)
	if err!=nil&&!errors.Is(err,pgx.ErrNoRows){return nil,err};stored:=dummyBcrypt;if user!=nil{stored=text(user["password_hash"])}
	valid,err:=s.checkPassword(ctx,password,stored);if err!=nil{return nil,err};if !valid||user==nil||user["deleted_at"]!=nil{return nil,apiError(401,"INVALID_CREDENTIALS","Invalid username or password")}
	return user,nil
}
func(s *Server)login(ctx context.Context,r *Request)(Result,error){
	user,err:=s.verifyCredentials(ctx,text(r.Body["username"]),text(r.Body["password"]));if err!=nil{return Result{},err}
	stored:=text(user["password_hash"]);cost,_:=bcrypt.Cost([]byte(stored))
	if cost<10||strings.HasPrefix(stored,"$2a$"){hash,err:=s.passwordHash(ctx,text(r.Body["password"]),12);if err!=nil{return Result{},err};if _,err=s.DB.Exec(ctx,`UPDATE users SET password_hash=$1,password_hash_version=password_hash_version+1,password_hash_needs_rehash=false,updated_at=NOW() WHERE id=$2 AND password_hash=$3`,hash,text(user["id"]),stored);err!=nil{return Result{},err}}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx)
	tokens,err:=s.createSession(ctx,tx,text(user["id"]),text(r.Body["deviceLabel"]),"");if err!=nil{return Result{},err};if err=tx.Commit(ctx);err!=nil{return Result{},err}
	return ok(Object{"accessToken":tokens.AccessToken,"refreshToken":tokens.RefreshToken,"expiresIn":600,"sessionId":tokens.SessionID,"user":userDTO(user)})
}
func(s *Server)me(ctx context.Context,r *Request)(Result,error){row,err:=one(ctx,s.DB,"SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL",r.Principal.UserID);if err!=nil{return Result{},err};return ok(userDTO(row))}
func(s *Server)listSessions(ctx context.Context,r *Request)(Result,error){rows,err:=many(ctx,s.DB,`SELECT to_jsonb(d) FROM device_sessions d WHERE user_id=$1 AND revoked_at IS NULL AND absolute_expires_at>NOW() ORDER BY last_seen_at DESC`,r.Principal.UserID);if err!=nil{return Result{},err};items:=make([]Object,0,len(rows));for _,row:=range rows{items=append(items,Object{"id":row["id"],"deviceLabel":row["device_label"],"createdAt":isoValue(row["created_at"]),"lastSeenAt":isoValue(row["last_seen_at"]),"expiresAt":isoValue(row["absolute_expires_at"])})};return ok(items)}
func revokeSessionTx(ctx context.Context,q Querier,user,session string)(bool,error){tag,err:=q.Exec(ctx,"UPDATE device_sessions SET revoked_at=NOW() WHERE id=$1 AND user_id=$2",session,user);if err!=nil||tag.RowsAffected()==0{return false,err};_,err=q.Exec(ctx,"UPDATE refresh_credentials SET revoked_at=NOW() WHERE session_id=$1 AND user_id=$2 AND revoked_at IS NULL",session,user);return true,err}
func(s *Server)revoke(ctx context.Context,user,session string)(bool,error){tx,err:=s.DB.Begin(ctx);if err!=nil{return false,err};defer rollback(tx);var cursor int64;if err=tx.QueryRow(ctx,"SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE",user).Scan(&cursor);err!=nil{return false,err};done,err:=revokeSessionTx(ctx,tx,user,session);if err!=nil{return false,err};return done,tx.Commit(ctx)}
func(s *Server)logout(ctx context.Context,r *Request)(Result,error){_,err:=s.revoke(ctx,r.Principal.UserID,r.Principal.SessionID);if err!=nil{return Result{},err};return ok(Object{"success":true})}
func(s *Server)revokeSessionHandler(ctx context.Context,r *Request)(Result,error){done,err:=s.revoke(ctx,r.Principal.UserID,r.Params["id"]);if err!=nil{return Result{},err};if !done{return Result{},apiError(404,"SESSION_NOT_FOUND","Session '"+r.Params["id"]+"' was not found or belongs to another user")};return ok(Object{"revoked":true})}

func(s *Server)changePassword(ctx context.Context,r *Request)(Result,error){
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx);var cursor int64
	if err=tx.QueryRow(ctx,"SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE",r.Principal.UserID).Scan(&cursor);err!=nil{return Result{},err}
	user,err:=one(ctx,tx,"SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL",r.Principal.UserID);if err!=nil{return Result{},err}
	valid,err:=s.checkPassword(ctx,text(r.Body["oldPassword"]),text(user["password_hash"]));if err!=nil{return Result{},err};if !valid{return Result{},apiError(401,"INVALID_CREDENTIALS","Current password does not match")}
	hash,err:=s.passwordHash(ctx,text(r.Body["newPassword"]),12);if err!=nil{return Result{},err}
	for _,command:=range []struct{sql string;args []any}{
		{`UPDATE users SET password_hash=$1,password_hash_version=password_hash_version+1,password_hash_needs_rehash=false,updated_at=NOW() WHERE id=$2`,[]any{hash,r.Principal.UserID}},
		{`UPDATE device_sessions SET revoked_at=NOW() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,[]any{r.Principal.UserID,r.Principal.SessionID}},
		{`UPDATE refresh_credentials SET revoked_at=NOW() WHERE user_id=$1 AND session_id<>$2 AND revoked_at IS NULL`,[]any{r.Principal.UserID,r.Principal.SessionID}},
		{`UPDATE user_sync_states SET cursor=cursor+1,updated_at=NOW() WHERE user_id=$1`,[]any{r.Principal.UserID}},
	}{if _,err=tx.Exec(ctx,command.sql,command.args...);err!=nil{return Result{},err}}
	if err=tx.Commit(ctx);err!=nil{return Result{},err};return ok(Object{"success":true})
}

func normalizeRecovery(raw string)string{var b strings.Builder;for _,r:=range strings.ToLower(strings.TrimSpace(raw)){if r>='a'&&r<='f'||r>='0'&&r<='9'{b.WriteRune(r)}};return b.String()}
func(s *Server)regenerateCodes(ctx context.Context,r *Request)(Result,error){
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx);var cursor int64
	if err=tx.QueryRow(ctx,"SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE",r.Principal.UserID).Scan(&cursor);err!=nil{return Result{},err}
	user,err:=one(ctx,tx,"SELECT to_jsonb(u) FROM users u WHERE id=$1 AND deleted_at IS NULL",r.Principal.UserID);if err!=nil{return Result{},err};valid,err:=s.checkPassword(ctx,text(r.Body["password"]),text(user["password_hash"]));if err!=nil{return Result{},err};if !valid{return Result{},apiError(401,"INVALID_CREDENTIALS","Current password does not match")}
	if _,err=tx.Exec(ctx,"UPDATE recovery_codes SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL AND used_at IS NULL",r.Principal.UserID);err!=nil{return Result{},err}
	batch:=newID();codes:=make([]string,0,10)
	for i:=0;i<10;i++{raw:=randomHex(16);chunks:=make([]string,0,8);for j:=0;j<32;j+=4{chunks=append(chunks,raw[j:j+4])};codes=append(codes,strings.Join(chunks,"-"));if _,err=tx.Exec(ctx,"INSERT INTO recovery_codes(code_hash,user_id,batch_id) VALUES($1,$2,$3)",hashText(raw),r.Principal.UserID,batch);err!=nil{return Result{},err}}
	if _,err=tx.Exec(ctx,"UPDATE user_sync_states SET cursor=cursor+1,updated_at=NOW() WHERE user_id=$1",r.Principal.UserID);err!=nil{return Result{},err};if err=tx.Commit(ctx);err!=nil{return Result{},err};return ok(Object{"codes":codes,"batchId":batch})
}
func(s *Server)recoverPassword(ctx context.Context,r *Request)(Result,error){
	deny:=apiError(401,"INVALID_RECOVERY_CODE","Invalid username or recovery code")
	code:=normalizeRecovery(text(r.Body["recoveryCode"]));if len(code)!=32{return Result{},deny}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx)
	user,err:=one(ctx,tx,"SELECT to_jsonb(u) FROM users u WHERE username=$1 AND deleted_at IS NULL",text(r.Body["username"]));if errors.Is(err,pgx.ErrNoRows){return Result{},deny};if err!=nil{return Result{},err};uid:=text(user["id"]);var cursor int64
	if err=tx.QueryRow(ctx,"SELECT cursor FROM user_sync_states WHERE user_id=$1 FOR UPDATE",uid).Scan(&cursor);err!=nil{return Result{},err}
	rec,err:=one(ctx,tx,"SELECT to_jsonb(c) FROM recovery_codes c WHERE code_hash=$1 AND user_id=$2 FOR UPDATE",hashText(code),uid);if errors.Is(err,pgx.ErrNoRows){return Result{},deny};if err!=nil{return Result{},err};if rec["used_at"]!=nil||rec["revoked_at"]!=nil{return Result{},deny}
	hash,err:=s.passwordHash(ctx,text(r.Body["newPassword"]),12);if err!=nil{return Result{},err}
	for _,cmd:=range []struct{sql string;args []any}{
		{"UPDATE recovery_codes SET used_at=NOW() WHERE code_hash=$1",[]any{hashText(code)}},
		{"UPDATE recovery_codes SET revoked_at=NOW() WHERE user_id=$1 AND batch_id=$2 AND used_at IS NULL",[]any{uid,text(rec["batch_id"])}},
		{"UPDATE users SET password_hash=$1,password_hash_version=password_hash_version+1,password_hash_needs_rehash=false,updated_at=NOW() WHERE id=$2",[]any{hash,uid}},
		{"UPDATE device_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL",[]any{uid}},
		{"UPDATE refresh_credentials SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL",[]any{uid}},
		{"UPDATE user_sync_states SET cursor=cursor+1,updated_at=NOW() WHERE user_id=$1",[]any{uid}},
	}{if _,err=tx.Exec(ctx,cmd.sql,cmd.args...);err!=nil{return Result{},err}}
	if err=tx.Commit(ctx);err!=nil{return Result{},err};return ok(Object{"success":true})
}
