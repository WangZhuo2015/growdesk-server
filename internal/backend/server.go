package backend

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Principal struct{ UserID, SessionID, Username, DeviceLabel string }
type Request struct {
	HTTP *http.Request
	Route *Route
	Params map[string]string
	Body Object
	// RawBody is bounded and used only for legacy ordered receipt hashing.
	RawBody []byte
	Principal Principal
	RequestID string
}
type Result struct { Status int; Body any; Headers http.Header; Stream func(http.ResponseWriter) error }
type Handler func(context.Context,*Request)(Result,error)
type Server struct {
	Config Config
	DB *pgxpool.Pool
	Redis *redis.Client
	Contract *Contract
	Handlers map[string]Handler
	Public map[string]bool
	Log *slog.Logger
	slots chan struct{}
	hashSlots chan struct{}
}

func NewServer(ctx context.Context,c Config,log *slog.Logger)(*Server,error){
	if log==nil{log=slog.Default()}
	contract,err:=LoadContract();if err!=nil{return nil,err}
	pool,err:=openDatabase(ctx,c);if err!=nil{return nil,err}
	if err=ValidateRedisURL(c.RedisURL,c.Environment=="test");err!=nil{pool.Close();return nil,err}
	rc,err:=redis.ParseURL(c.RedisURL);if err!=nil{pool.Close();return nil,errors.New("invalid Redis configuration")}
	rc.PoolSize=int(c.MaxDBConnections);rc.DialTimeout=3*time.Second;rc.ReadTimeout=3*time.Second;rc.WriteTimeout=3*time.Second;rc.MaxRetries=1
	s:=&Server{Config:c,DB:pool,Redis:redis.NewClient(rc),Contract:contract,Handlers:map[string]Handler{},Public:map[string]bool{},Log:log,slots:make(chan struct{},c.MaxConcurrentRequests),hashSlots:make(chan struct{},4)}
	s.registerHealth();return s,nil
}
func(s *Server)Close(){_=s.Redis.Close();s.DB.Close()}
func(s *Server)Register(id string,public bool,h Handler){
	if s.Handlers[id]!=nil{panic("duplicate native handler: "+id)}
	if s.Contract.ByID[id]==nil{panic("handler without contract: "+id)}
	s.Handlers[id],s.Public[id]=h,public
}

// Snapshot DELETE explicitly defines both null and omitted bodies as {}.
// No other JSON API gains nullable-object coercion from this compatibility rule.
func decodeNativeBody(operation string,raw []byte)(Object,error){
	var body Object
	if err:=decodeJSON(raw,&body);err!=nil{return nil,invalid("Invalid JSON object")}
	if body==nil{
		if operation=="deleteRecordWithSnapshot"{return Object{},nil}
		return nil,invalid("Invalid JSON object")
	}
	return body,nil
}

func(s *Server)ServeHTTP(w http.ResponseWriter,r *http.Request){
	requestID:=newID();w.Header().Set("X-Request-ID",requestID);w.Header().Set("Cache-Control","private, no-store");w.Header().Set("X-Content-Type-Options","nosniff")
	defer func(){if v:=recover();v!=nil{s.Log.Error("request panic","requestId",requestID);s.writeError(w,apiError(500,"INTERNAL_ERROR","An unexpected error occurred"),requestID)}}()
	route,params:=s.matchNativeRoute(r.Method,r.URL.Path)
	if route==nil{s.writeError(w,apiError(404,"NOT_FOUND","Route not found"),requestID);return}
	select{case s.slots<-struct{}{}:defer func(){<-s.slots}();default:w.Header().Set("Retry-After","1");s.writeError(w,apiError(503,"SERVER_BUSY","Server concurrency limit reached"),requestID);return}
	ctx,cancel:=context.WithTimeout(r.Context(),s.Config.RequestTimeout);defer cancel();r=r.WithContext(ctx)
	body:=Object(nil);if route.OperationID=="deleteRecordWithSnapshot"{body=Object{}}
	var rawBody []byte
	if r.Body!=nil&&r.ContentLength!=0{
		raw,err:=io.ReadAll(io.LimitReader(r.Body,s.Config.MaxBodyBytes+1));if err!=nil{s.writeError(w,invalid("Cannot read request body"),requestID);return}
		if int64(len(raw))>s.Config.MaxBodyBytes{s.writeError(w,apiError(413,"FST_ERR_CTP_BODY_TOO_LARGE","Request body is too large"),requestID);return}
		if len(raw)>0{
			mediaType,_,mediaErr:=mime.ParseMediaType(r.Header.Get("Content-Type"))
			if mediaErr!=nil||mediaType!="application/json"{s.writeError(w,apiError(415,"FST_ERR_CTP_INVALID_MEDIA_TYPE","Expected application/json"),requestID);return}
			body,err=decodeNativeBody(route.OperationID,raw);if err!=nil{s.writeError(w,err,requestID);return}
			switch route.OperationID{case "createGrowthMeasurement","updateGrowthMeasurement","createMedicalReport","createVaccineRecord":rawBody=raw}
		}
	}
	if err:=normalizeReferenceCatalogQuery(route.OperationID,r);err!=nil{s.writeError(w,err,requestID);return}
	if err:=route.Validate(r,params,body);err!=nil{s.writeError(w,err,requestID);return}
	req:=&Request{HTTP:r,Route:route,Params:params,Body:body,RawBody:rawBody,RequestID:requestID}
	if !s.Public[route.OperationID]{p,err:=s.authenticate(ctx,r);if err!=nil{s.writeError(w,err,requestID);return};req.Principal=p}
	h:=s.Handlers[route.OperationID];if h==nil{s.writeError(w,apiError(503,"GO_OPERATION_NOT_IMPLEMENTED","Operation is not implemented in this Go build"),requestID);return}
	result,err:=h(ctx,req);if err!=nil{s.writeError(w,err,requestID);return}
	if result.Status==0{result.Status=200}
	for k,values:=range result.Headers{for _,v:=range values{w.Header().Add(k,v)}}
	if result.Stream!=nil{if err:=result.Stream(w);err!=nil{s.Log.Warn("stream interrupted","operationId",route.OperationID,"requestId",requestID)};return}
	raw,err:=jsonBytes(result.Body);if err!=nil{s.writeError(w,err,requestID);return}
	w.Header().Set("Content-Type","application/json; charset=utf-8");w.WriteHeader(result.Status);if r.Method!=http.MethodHead{_,_=w.Write(raw)}
}
func(s *Server)writeError(w http.ResponseWriter,err error,id string){
	e:=normalizedError(err);body:=Object{"code":e.Code,"message":e.Message,"requestId":id};if e.Details!=nil{body["details"]=e.Details}
	raw,_:=jsonBytes(Object{"error":body});w.Header().Set("Content-Type","application/json; charset=utf-8");w.WriteHeader(e.Status);_,_=w.Write(raw)
}
func ok(v any)(Result,error){return Result{Status:200,Body:envelope(v)},nil}
func created(v any)(Result,error){return Result{Status:201,Body:envelope(v)},nil}
func(s *Server)registerHealth(){
	s.Register("getHealthLive",true,func(ctx context.Context,r *Request)(Result,error){return Result{Status:200,Body:Object{"status":"ok","service":"growdesk-api"}},nil})
	s.Register("getHealthReady",true,func(ctx context.Context,r *Request)(Result,error){
		ctx,cancel:=context.WithTimeout(ctx,3*time.Second);defer cancel()
		pgOK:=s.DB.Ping(ctx)==nil;redisOK:=s.Redis.Ping(ctx).Err()==nil
		status,code:="ok",200;p,rd:="ok","ok";if !pgOK{p="unavailable"};if !redisOK{rd="unavailable"};if !pgOK||!redisOK{status,code="unavailable",503}
		return Result{Status:code,Body:Object{"status":status,"service":"growdesk-api","stage":"foundation","dependencies":Object{"postgres":p,"redis":rd}}},nil
	})
}
