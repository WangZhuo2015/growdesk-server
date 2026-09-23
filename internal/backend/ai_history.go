package backend

import (
	"context"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerAIHistory(){
	s.Register("createAiSession",false,s.createCoreAISession)
	s.Register("listAiSessions",false,s.listCoreAISessions)
	s.Register("listAiSessionMessages",false,s.listCoreAIMessages)
	s.Register("listDailySummaries",false,s.listDailySummaries)
}

func coreAISessionDTO(row Object) Object {
	return Object{"id":row["id"],"userId":row["user_id"],"babyId":row["baby_id"],"title":row["title"],"createdAt":isoValue(row["created_at"]),"updatedAt":isoValue(row["updated_at"])}
}

func coreAIPageLimit(r *Request,fallback int) int {
	n:=fallback
	if raw:=r.HTTP.URL.Query().Get("limit");raw!="" { if value,err:=strconv.Atoi(raw);err==nil { n=value } }
	if n<1 { n=1 }; if n>100 { n=100 }; return n
}

// Both membership edges are required. A family role is not a baby's ACL, and
// a surviving baby_member row is not sufficient after family revocation.
const coreAISessionVisibility = `(a.baby_id IS NULL OR EXISTS(
	SELECT 1 FROM babies b
	JOIN families f ON f.id=b.family_id AND f.deleted_at IS NULL
	JOIN family_members fm ON fm.family_id=b.family_id AND fm.user_id=a.user_id AND fm.status='active' AND fm.deleted_at IS NULL AND fm.role IN ('admin','member','viewer')
	JOIN baby_members bm ON bm.baby_id=b.id AND bm.family_id=b.family_id AND bm.user_id=a.user_id AND bm.status='active' AND bm.deleted_at IS NULL AND bm.role IN ('admin','member','viewer')
	WHERE b.id=a.baby_id AND b.deleted_at IS NULL))`

func ownedCoreAISession(ctx context.Context,q Querier,userID,id string,lock bool)(Object,error){
	query:="SELECT to_jsonb(a) FROM ai_sessions a WHERE id=$1 AND user_id=$2"
	if lock { query+=" FOR UPDATE" }
	row,err:=one(ctx,q,query,id,userID)
	if errors.Is(err,pgx.ErrNoRows) { return nil,notFound("AiSession",id) }
	if err!=nil { return nil,err }
	if baby:=text(row["baby_id"]);baby!="" { if _,err=babyScope(ctx,q,userID,baby,false);err!=nil { return nil,err } }
	return row,nil
}

func (s *Server) createCoreAISession(ctx context.Context,r *Request)(Result,error){
	tx,err:=s.DB.Begin(ctx); if err!=nil { return Result{},err }; defer rollback(tx)
	var active string
	if err=tx.QueryRow(ctx,"SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",r.Principal.UserID).Scan(&active);err!=nil {
		if errors.Is(err,pgx.ErrNoRows) { return Result{},apiError(401,"UNAUTHORIZED","Account is no longer active") }; return Result{},err
	}
	var baby any
	if id:=text(r.Body["babyId"]);id!="" {
		scope,err:=babyScope(ctx,tx,r.Principal.UserID,id,false); if err!=nil { return Result{},err }
		if _,err=lockFamily(ctx,tx,scope.FamilyID);err!=nil { return Result{},err }
		if _,err=babyScope(ctx,tx,r.Principal.UserID,id,false);err!=nil { return Result{},err }
		baby=id
	}
	title:="新对话"; if value,exists:=r.Body["title"];exists&&value!=nil { title=text(value) }
	row,err:=one(ctx,tx,`INSERT INTO ai_sessions AS a(id,user_id,baby_id,title,context_type,created_at,updated_at)
		VALUES($1,$2,$3,$4,'general',NOW(),NOW()) RETURNING to_jsonb(a)`,newID(),r.Principal.UserID,baby,title)
	if err!=nil { return Result{},err }; if err=tx.Commit(ctx);err!=nil { return Result{},err }
	return created(coreAISessionDTO(row))
}

func (s *Server) listCoreAISessions(ctx context.Context,r *Request)(Result,error){
	return s.readSnapshot(ctx,func(q Querier)(Result,error){
		limit:=coreAIPageLimit(r,20)
		args:=[]any{r.Principal.UserID}
		where:="a.user_id=$1 AND "+coreAISessionVisibility
		if cursor:=r.HTTP.URL.Query().Get("cursor");cursor!="" {
			args=append(args,cursor)
			where+=` AND (a.updated_at,a.id)<(SELECT a.updated_at,a.id FROM ai_sessions a WHERE a.id=$2 AND a.user_id=$1 AND `+coreAISessionVisibility+`)`
		}
		args=append(args,limit+1)
		rows,err:=many(ctx,q,"SELECT to_jsonb(a) FROM ai_sessions a WHERE "+where+" ORDER BY a.updated_at DESC,a.id DESC LIMIT $"+strconv.Itoa(len(args)),args...)
		if err!=nil { return Result{},err }
		var next any
		if len(rows)>limit { rows=rows[:limit]; next=rows[len(rows)-1]["id"] }
		items:=make([]Object,0,len(rows)); for _,row:=range rows { items=append(items,coreAISessionDTO(row)) }
		return Result{Status:200,Body:page(items,next)},nil
	})
}

func (s *Server) listCoreAIMessages(ctx context.Context,r *Request)(Result,error){
	return s.readSnapshot(ctx,func(q Querier)(Result,error){
		id:=r.Params["id"]
		if _,err:=ownedCoreAISession(ctx,q,r.Principal.UserID,id,false);err!=nil { return Result{},err }
		limit:=coreAIPageLimit(r,50)
		args:=[]any{id}
		where:="m.session_id=$1"
		if cursor:=r.HTTP.URL.Query().Get("cursor");cursor!="" {
			args=append(args,cursor)
			where+=` AND (m.created_at,m.id)>(SELECT created_at,id FROM ai_messages WHERE id=$2 AND session_id=$1)`
		}
		args=append(args,limit+1)
		rows,err:=many(ctx,q,"SELECT to_jsonb(m) FROM ai_messages m WHERE "+where+" ORDER BY m.created_at ASC,m.id ASC LIMIT $"+strconv.Itoa(len(args)),args...)
		if err!=nil { return Result{},err }
		var next any
		if len(rows)>limit { rows=rows[:limit]; next=rows[len(rows)-1]["id"] }
		items:=make([]Object,0,len(rows))
		for _,row:=range rows { items=append(items,Object{"id":row["id"],"sessionId":row["session_id"],"role":row["role"],"content":row["content"],"attachmentIds":[]string{},"createdAt":isoValue(row["created_at"])}) }
		return Result{Status:200,Body:page(items,next)},nil
	})
}

func (s *Server) listDailySummaries(ctx context.Context,r *Request)(Result,error){
	return s.readSnapshot(ctx,func(q Querier)(Result,error){
		scope,err:=babyScope(ctx,q,r.Principal.UserID,r.Params["babyId"],false);if err!=nil { return Result{},err }
		limit:=coreAIPageLimit(r,20)
		args:=[]any{scope.FamilyID,scope.BabyID}
		where:="family_id=$1 AND baby_id=$2"
		if cursor:=r.HTTP.URL.Query().Get("cursor");cursor!="" { args=append(args,cursor);where+=" AND (target_date,id)<(SELECT target_date,id FROM daily_summaries WHERE id=$3 AND family_id=$1 AND baby_id=$2)" }
		args=append(args,limit+1)
		rows,err:=many(ctx,q,"SELECT to_jsonb(d) FROM daily_summaries d WHERE "+where+" ORDER BY target_date DESC,id DESC LIMIT $"+strconv.Itoa(len(args)),args...)
		if err!=nil { return Result{},err }
		var next any
		if len(rows)>limit { rows=rows[:limit];next=rows[len(rows)-1]["id"] }
		items:=make([]Object,0,len(rows))
		for _,row:=range rows { items=append(items,Object{"id":row["id"],"babyId":row["baby_id"],"familyId":row["family_id"],"targetDate":dateValue(row["target_date"]),"content":row["content"],"version":text(row["version"]),"createdAt":isoValue(row["created_at"])}) }
		return Result{Status:200,Body:page(items,next)},nil
	})
}
