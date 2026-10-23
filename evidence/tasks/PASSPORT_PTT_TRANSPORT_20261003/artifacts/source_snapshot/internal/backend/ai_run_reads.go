package backend

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerAIRunReads(){
	s.Register("getAiRun",false,s.getNativeAIRun)
	s.Register("getAiRunEvents",false,s.getNativeAIRunEvents)
}

func readOwnedAIRun(ctx context.Context,q Querier,userID,id string)(Object,error){
	row,err:=one(ctx,q,`SELECT to_jsonb(r)||jsonb_build_object('__task',to_jsonb(t))
		FROM ai_runs r JOIN task_executions t ON t.id=r.id JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL
		WHERE r.id=$1 AND r.user_id=$2`,id,userID)
	if errors.Is(err,pgx.ErrNoRows){return nil,notFound("AiRun",id)};if err!=nil{return nil,err}
	if baby:=text(row["baby_id"]);baby!=""{if _,err=babyScope(ctx,q,userID,baby,false);err!=nil{return nil,err}}
	return row,nil
}

func aiRunReadDTO(row Object)Object{
	task:=obj(row["__task"]);attempt:=integer(task["attempt"]);if attempt<1{attempt=1}
	return Object{"id":row["id"],"sessionId":row["session_id"],"userId":row["user_id"],"babyId":row["baby_id"],
		"status":task["status"],"attempt":attempt,"lastEventSeq":text(row["last_event_seq"]),"resultSummary":row["result_summary"],"proposedPlan":row["proposed_plan"],
		"errorCode":row["error_code"],"errorMessage":row["error_message"],"createdAt":isoValue(task["created_at"]),"startedAt":isoValue(row["started_at"]),"finishedAt":isoValue(row["finished_at"])}
}

func (s *Server) getNativeAIRun(ctx context.Context,r *Request)(Result,error){
	return s.readSnapshot(ctx,func(q Querier)(Result,error){row,err:=readOwnedAIRun(ctx,q,r.Principal.UserID,r.Params["id"]);if err!=nil{return Result{},err};return ok(aiRunReadDTO(row))})
}

func aiEventCursor(raw string)(int64,bool,error){
	raw=strings.TrimSpace(raw);if raw==""{return 0,false,nil}
	for _,c:=range raw{if c<'0'||c>'9'{return 0,false,apiError(400,"INVALID_EVENT_CURSOR","SSE event cursor must be a non-negative integer")}}
	n,err:=strconv.ParseInt(raw,10,64);if err!=nil{return 0,false,apiError(400,"INVALID_EVENT_CURSOR","SSE event cursor exceeds the database range")};return n,true,nil
}

type aiEventReadBatch struct{Events []Object;Terminal bool;HighWater int64}
func (s *Server) readAIEventBatch(ctx context.Context,userID,runID string,after int64)(aiEventReadBatch,error){
	batch:=aiEventReadBatch{Events:[]Object{}}
	_,err:=s.readSnapshot(ctx,func(q Querier)(Result,error){
		run,err:=readOwnedAIRun(ctx,q,userID,runID);if err!=nil{return Result{},err}
		task:=obj(run["__task"]);status:=text(task["status"]);batch.Terminal=status=="succeeded"||status=="failed"||status=="cancelled";batch.HighWater=integer(run["last_event_seq"])
		fallback:=integer(task["attempt"]);if fallback<1{fallback=1}
		// Small internal batches bound per-stream memory independently of the
		// total retained history. Every batch rechecks current permissions.
		rows,err:=many(ctx,q,`SELECT to_jsonb(e) FROM ai_run_events e WHERE run_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence ASC LIMIT 8`,runID,after,batch.HighWater)
		if err!=nil{return Result{},err}
		for _,row:=range rows{
			payload:=copyObject(obj(row["payload"]));attempt:=integer(payload["attempt"]);if attempt<1{attempt=fallback};delete(payload,"attempt")
			item:=Object{"runId":runID,"seq":text(row["sequence"]),"attempt":attempt,"type":row["event_type"],"payload":payload}
			raw,err:=jsonBytes(item);if err!=nil{return Result{},err};if len(raw)>256*1024{return Result{},apiError(503,"AI_EVENT_TOO_LARGE","Stored AI event exceeds the streaming budget")}
			batch.Events=append(batch.Events,item)
		}
		return Result{},nil
	})
	return batch,err
}

func writeNativeSSE(ctx context.Context,w http.ResponseWriter,frame []byte)error{
	controller:=http.NewResponseController(w)
	deadline:=time.Now().Add(5*time.Second);if limit,ok:=ctx.Deadline();ok&&limit.Before(deadline){deadline=limit}
	if err:=controller.SetWriteDeadline(deadline);err!=nil{return err}
	if _,err:=w.Write(frame);err!=nil{return err};return controller.Flush()
}

func (s *Server) getNativeAIRunEvents(ctx context.Context,r *Request)(Result,error){
	query,qPresent,err:=aiEventCursor(r.HTTP.URL.Query().Get("after"));if err!=nil{return Result{},err}
	header,hPresent,err:=aiEventCursor(r.HTTP.Header.Get("Last-Event-ID"));if err!=nil{return Result{},err}
	if qPresent&&hPresent&&query!=header{return Result{},apiError(400,"EVENT_CURSOR_CONFLICT","after and Last-Event-ID must identify the same cursor")}
	cursor:=query;if hPresent{cursor=header}
	batch,err:=s.readAIEventBatch(ctx,r.Principal.UserID,r.Params["id"],cursor);if err!=nil{return Result{},err}
	return Result{Status:200,Stream:func(w http.ResponseWriter)error{
		w.Header().Set("Content-Type","text/event-stream; charset=utf-8");w.Header().Set("Cache-Control","no-cache, no-transform");w.Header().Set("X-Accel-Buffering","no");w.WriteHeader(200)
		lastHeartbeat:=time.Now()
		for{
			for _,event:=range batch.Events{
				encoded,err:=jsonBytes(event);if err!=nil{return err}
				frame:=[]byte(fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n",text(event["seq"]),text(event["type"]),encoded))
				if err=writeNativeSSE(ctx,w,frame);err!=nil{return err};cursor=integer(event["seq"])
			}
			// Drain every retained terminal event, not just the first page.
			if batch.Terminal&&(cursor>=batch.HighWater||len(batch.Events)==0){return nil}
			if time.Since(lastHeartbeat)>=15*time.Second{if err:=writeNativeSSE(ctx,w,[]byte(": heartbeat\n\n"));err!=nil{return err};lastHeartbeat=time.Now()}
			if len(batch.Events)<8{timer:=time.NewTimer(250*time.Millisecond);select{case<-ctx.Done():timer.Stop();return ctx.Err();case<-timer.C:}}
			batch,err=s.readAIEventBatch(ctx,r.Principal.UserID,r.Params["id"],cursor);if err!=nil{return err}
		}
	}},nil
}
