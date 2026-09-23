package backend

import (
	"context"
	"encoding/base64"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) registerRecordSnapshots(){
	s.Register("listRecordSnapshots",false,s.listRecordSnapshots)
	s.Register("getRecordSnapshot",false,s.getRecordSnapshot)
	s.Register("deleteRecordWithSnapshot",false,s.deleteRecordWithSnapshot)
	s.Register("restoreRecordSnapshot",false,s.restoreRecordSnapshot)
	s.Register("restoreLatestRecordSnapshot",false,s.restoreRecordSnapshot)
}

func snapshotKind(kind string)string{if kind=="medical_report"{return "medical"};return kind}

func snapshotTarget(ctx context.Context,q Querier,kind,id string,scope Scope,lock bool)(Object,error){
	table,err:=snapshotTable(kind);if err!=nil{return nil,err}
	query:="SELECT to_jsonb(t) FROM "+pgx.Identifier{table}.Sanitize()+" t WHERE id=$1 AND family_id=$2 AND baby_id=$3"
	if lock{query+=" FOR UPDATE"}
	row,err:=one(ctx,q,query,id,scope.FamilyID,scope.BabyID)
	if errors.Is(err,pgx.ErrNoRows){return nil,nil};return row,err
}

func (s *Server) snapshotMutation(ctx context.Context,r *Request,fn func(pgx.Tx,Scope,int64)(Result,error))(result Result,err error){
	defer func(){err=legacyQueryFailure(err)}()
	scope,err:=babyScope(ctx,s.DB,r.Principal.UserID,r.Params["babyId"],true);if err!=nil{return Result{},err}
	tx,err:=s.DB.Begin(ctx);if err!=nil{return Result{},err};defer rollback(tx)
	cursor,err:=lockFamily(ctx,tx,scope.FamilyID);if err!=nil{return Result{},err}
	current,err:=babyScope(ctx,tx,r.Principal.UserID,scope.BabyID,true);if err!=nil{return Result{},err}
	if current.FamilyID!=scope.FamilyID{return Result{},apiError(403,"BABY_SCOPE_MISMATCH","Baby scope changed")}
	if cursor==math.MaxInt64{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Sync cursor exhausted")}
	result,err=fn(tx,current,cursor);if err!=nil{return Result{},err}
	if err=tx.Commit(ctx);err!=nil{return Result{},err};return result,nil
}

func publishSnapshotChange(ctx context.Context,tx pgx.Tx,scope Scope,kind,id,snapshotID string,cursor,version int64,restore bool)error{
	op:="delete";var deleted any=time.Now().UTC()
	payload:=Object{"id":id,"babyId":scope.BabyID,"snapshotId":snapshotID}
	if restore{op="upsert";deleted=nil;payload["restored"]=true}
	_,err:=tx.Exec(ctx,`UPDATE timeline_entries SET deleted_at=$5,version=version+1,updated_at=NOW()
		WHERE family_id=$1 AND baby_id=$2 AND entity_type=$3 AND entity_id=$4`,scope.FamilyID,scope.BabyID,snapshotKind(kind),id,deleted)
	if err!=nil{return err}
	if _,err=tx.Exec(ctx,`UPDATE family_sync_states SET cursor=$2,updated_at=NOW() WHERE family_id=$1`,scope.FamilyID,cursor);err!=nil{return err}
	raw,err:=jsonText(payload);if err!=nil{return err}
	_,err=tx.Exec(ctx,`INSERT INTO family_changes(family_id,cursor,entity_type,entity_id,version,op,payload,schema_version,created_at)
		VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,1,NOW())`,scope.FamilyID,cursor,snapshotKind(kind),id,version,op,raw)
	return err
}

func (s *Server) deleteRecordWithSnapshot(ctx context.Context,r *Request)(Result,error){
	kind,id:=r.Params["entityType"],r.Params["entityId"]
	table,err:=snapshotTable(kind);if err!=nil{return Result{},err}
	var requested any
	if value,present:=r.Body["baseVersion"];present&&value!=nil{
		version,err:=syncPosition(text(value));if err!=nil{return Result{},apiError(400,"INVALID_BASE_VERSION","Invalid record version")};requested=version
	}
	return s.snapshotMutation(ctx,r,func(tx pgx.Tx,scope Scope,cursor int64)(Result,error){
		requestHash,err:=snapshotHash(Object{"operation":"delete_with_snapshot","familyId":scope.FamilyID,"babyId":scope.BabyID,"entityType":kind,"entityId":id,"baseVersion":requested});if err!=nil{return Result{},err}
		key:=r.HTTP.Header.Get("Idempotency-Key")
		if key!=""{
			receipt,err:=one(ctx,tx,`SELECT to_jsonb(i) FROM idempotency_receipts i WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3`,r.Principal.UserID,scope.FamilyID,key)
			if err==nil{
				if strings.TrimSpace(text(receipt["request_hash"]))!=requestHash{return Result{},reusedKey(key)}
				response:=obj(receipt["response_body"])
				if response==nil||text(response["id"])!=id||text(response["entityType"])!=kind{return Result{},reusedKey(key)}
				return ok(response)
			}
			if !errors.Is(err,pgx.ErrNoRows){return Result{},err}
		}
		existing,err:=snapshotTarget(ctx,tx,kind,id,scope,true);if err!=nil{return Result{},err}
		if existing==nil||existing["deleted_at"]!=nil{return Result{},notFound(kind,id)}
		version:=integer(existing["version"])
		if requested!=nil&&requested.(int64)!=version{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Record changed before snapshot delete")}
		if version>=math.MaxInt32{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Snapshot change version exceeds sync range")}
		payload:=snapshotPayload(kind,existing)
		hash,err:=snapshotHash(payload);if err!=nil{return Result{},err}
		raw,err:=jsonText(payload);if err!=nil{return Result{},err}
		snapshotID:=newID()
		_,err=tx.Exec(ctx,`INSERT INTO record_snapshots(id,family_id,baby_id,user_id,source,source_agent,action,entity_type,entity_id,payload_json,payload_hash,restored,created_at)
			VALUES($1,$2,$3,$4,'mcp',NULL,'delete',$5,$6,$7::jsonb,$8,false,NOW())`,snapshotID,scope.FamilyID,scope.BabyID,r.Principal.UserID,kind,id,raw,hash)
		if err!=nil{return Result{},err}
		if kind=="food_plan"{
			_,err=tx.Exec(ctx,"DELETE FROM baby_food_plans WHERE id=$1 AND family_id=$2 AND baby_id=$3",id,scope.FamilyID,scope.BabyID)
		}else{
			version++
			_,err=tx.Exec(ctx,"UPDATE "+pgx.Identifier{table}.Sanitize()+" SET deleted_at=NOW(),updated_at=NOW(),version=$4 WHERE id=$1 AND family_id=$2 AND baby_id=$3",id,scope.FamilyID,scope.BabyID,version)
		}
		if err!=nil{return Result{},err}
		if err=publishSnapshotChange(ctx,tx,scope,kind,id,snapshotID,cursor+1,version,false);err!=nil{return Result{},err}
		response:=Object{"success":true,"id":id,"deleted":true,"snapshotId":snapshotID,"entityType":kind,"version":strconv.FormatInt(version,10)}
		if key!=""{
			body,err:=jsonText(response);if err!=nil{return Result{},err}
			summary,err:=jsonText(Object{"version":version,"familyCursor":strconv.FormatInt(cursor+1,10)});if err!=nil{return Result{},err}
			_,err=tx.Exec(ctx,`INSERT INTO idempotency_receipts(actor_id,scope_id,command_id,request_hash,result_code,result_summary,response_body,completed_at)
				VALUES($1,$2,$3,$4,200,$5::jsonb,$6::jsonb,NOW())`,r.Principal.UserID,scope.FamilyID,key,requestHash,summary,body)
			if err!=nil{return Result{},err}
		}
		return ok(response)
	})
}

func (s *Server) listRecordSnapshots(ctx context.Context,r *Request)(Result,error){
	return s.readSnapshot(ctx,func(q Querier)(Result,error){
		scope,err:=babyScope(ctx,q,r.Principal.UserID,r.Params["babyId"],false);if err!=nil{return Result{},err}
		where:="family_id=$1 AND baby_id=$2";args:=[]any{scope.FamilyID,scope.BabyID}
		if kind:=r.HTTP.URL.Query().Get("entityType");kind!=""{args=append(args,kind);where+=" AND entity_type=$"+strconv.Itoa(len(args))}
		if cursor:=r.HTTP.URL.Query().Get("cursor");cursor!=""{
			raw,err:=base64.RawURLEncoding.DecodeString(strings.TrimRight(cursor,"="));split:=strings.LastIndex(string(raw),"|")
			if err!=nil||split<1||split==len(raw)-1{return Result{},apiError(400,"INVALID_CURSOR","Invalid record snapshot cursor")}
			clock,err:=asTime(string(raw[:split]));if err!=nil{return Result{},apiError(400,"INVALID_CURSOR","Invalid record snapshot cursor")}
			args=append(args,clock,string(raw[split+1:]));where+=" AND (created_at,id)<($"+strconv.Itoa(len(args)-1)+",$"+strconv.Itoa(len(args))+")"
		}
		limit:=pageLimit(r);args=append(args,limit+1)
		rows,err:=many(ctx,q,"SELECT to_jsonb(s) FROM record_snapshots s WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT $"+strconv.Itoa(len(args)),args...);if err!=nil{return Result{},err}
		var next any;if len(rows)>limit{rows=rows[:limit];last:=rows[len(rows)-1];next=encodeCareCursor(last["created_at"],last["id"])}
		data:=make([]Object,0,len(rows));for _,row:=range rows{data=append(data,recordSnapshotDTO(row))};return Result{Status:200,Body:page(data,next)},nil
	})
}

func (s *Server) getRecordSnapshot(ctx context.Context,r *Request)(Result,error){
	return s.readSnapshot(ctx,func(q Querier)(Result,error){
		scope,err:=babyScope(ctx,q,r.Principal.UserID,r.Params["babyId"],false);if err!=nil{return Result{},err}
		row,err:=one(ctx,q,"SELECT to_jsonb(s) FROM record_snapshots s WHERE id=$1 AND family_id=$2 AND baby_id=$3",r.Params["snapshotId"],scope.FamilyID,scope.BabyID)
		if errors.Is(err,pgx.ErrNoRows){return Result{},notFound("record_snapshot",r.Params["snapshotId"])};if err!=nil{return Result{},err};return ok(recordSnapshotDTO(row))
	})
}

func (s *Server) restoreRecordSnapshot(ctx context.Context,r *Request)(Result,error){
	return s.snapshotMutation(ctx,r,func(tx pgx.Tx,scope Scope,cursor int64)(Result,error){
		id:=r.Params["snapshotId"];if id==""{id=text(r.Body["snapshotId"])}
		where:="family_id=$1 AND baby_id=$2";args:=[]any{scope.FamilyID,scope.BabyID}
		if id!=""{args=append(args,id);where+=" AND id=$3"}else{
			where+=" AND action='delete' AND restored=false"
			if kind:=text(r.Body["entityType"]);kind!=""{args=append(args,kind);where+=" AND entity_type=$3"}
		}
		row,err:=one(ctx,tx,"SELECT to_jsonb(s) FROM record_snapshots s WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",args...)
		if errors.Is(err,pgx.ErrNoRows){return Result{},notFound("record_snapshot",id)};if err!=nil{return Result{},err}
		id=text(row["id"]);kind,targetID:=text(row["entity_type"]),text(row["entity_id"])
		table,err:=snapshotTable(kind);if err!=nil{return Result{},err}
		if text(row["action"])!="delete"{return Result{},apiError(422,"UNSUPPORTED_SNAPSHOT_ACTION","Only delete snapshots can be restored")}
		payload:=obj(row["payload_json"])
		if payload==nil||text(payload["id"])!=targetID||text(payload["familyId"])!=scope.FamilyID||text(payload["babyId"])!=scope.BabyID{return Result{},apiError(409,"SNAPSHOT_INVALID_PAYLOAD","Snapshot target scope is invalid")}
		hash,err:=snapshotHash(payload);if err!=nil{return Result{},err}
		if hash!=strings.TrimSpace(text(row["payload_hash"])){return Result{},apiError(409,"SNAPSHOT_TAMPERED","Snapshot integrity check failed")}
		if boolean(row["restored"]){return ok(Object{"success":true,"snapshotId":id,"restoredId":targetID,"entityType":kind,"replayed":true})}
		current,err:=snapshotTarget(ctx,tx,kind,targetID,scope,true);if err!=nil{return Result{},err}
		version:=int64(0)
		if kind=="food_plan"{
			if current!=nil{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Food plan is already active")}
			var slot bool
			if err=tx.QueryRow(ctx,"SELECT EXISTS(SELECT 1 FROM baby_food_plans WHERE baby_id=$1)",scope.BabyID).Scan(&slot);err!=nil{return Result{},err}
			if slot{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Another food plan occupies the baby's slot")}
			version,err=syncPosition(text(payload["version"]));if err!=nil||version<1||version>=math.MaxInt32{return Result{},apiError(409,"SNAPSHOT_INVALID_PAYLOAD","Invalid food-plan snapshot version")}
			createdAt,e1:=asTime(payload["createdAt"]);updatedAt,e2:=asTime(payload["updatedAt"])
			if e1!=nil||e2!=nil||updatedAt.Before(createdAt)||obj(payload["planData"])==nil{return Result{},apiError(409,"SNAPSHOT_INVALID_PAYLOAD","Invalid food-plan snapshot document")}
			raw,err:=jsonText(payload["planData"]);if err!=nil{return Result{},err}
			_,err=tx.Exec(ctx,`INSERT INTO baby_food_plans(id,family_id,baby_id,plan_data,version,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`,targetID,scope.FamilyID,scope.BabyID,raw,version,createdAt,updatedAt)
			if err!=nil{return Result{},err}
		}else{
			if current==nil{return Result{},notFound(kind,targetID)}
			if current["deleted_at"]==nil{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Record is already active")}
			before,err:=snapshotHash(snapshotComparable(payload));if err!=nil{return Result{},err}
			after,err:=snapshotHash(snapshotComparable(snapshotPayload(kind,current)));if err!=nil{return Result{},err}
			if before!=after{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Record no longer matches its snapshot")}
			version=integer(current["version"])+1;if version>=math.MaxInt32{return Result{},apiError(409,"CONCURRENCY_CONFLICT","Record version exhausted")}
			if kind=="sleep"{
				if err=validateCareMutation(ctx,tx,careSpec{Kind:"sleep"},scope,targetID,"create",Object{},Object{"started_at":current["started_at"],"ended_at":current["ended_at"]},nil);err!=nil{return Result{},err}
			}
			if kind=="growth"{if err=validateGrowthAttachment(ctx,tx,current["attachment_id"],scope);err!=nil{return Result{},err}}
			_,err=tx.Exec(ctx,"UPDATE "+pgx.Identifier{table}.Sanitize()+" SET deleted_at=NULL,updated_at=NOW(),version=$4 WHERE id=$1 AND family_id=$2 AND baby_id=$3",targetID,scope.FamilyID,scope.BabyID,version)
			if err!=nil{return Result{},err}
		}
		if err=publishSnapshotChange(ctx,tx,scope,kind,targetID,id,cursor+1,version,true);err!=nil{return Result{},err}
		if _,err=tx.Exec(ctx,"UPDATE record_snapshots SET restored=true,restored_at=NOW() WHERE id=$1",id);err!=nil{return Result{},err}
		return ok(Object{"success":true,"snapshotId":id,"restoredId":targetID,"entityType":kind,"version":strconv.FormatInt(version,10)})
	})
}
