package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Server) registerGrowth() {
	s.Register("listGrowthMeasurements", false, s.listGrowthMeasurements)
	s.Register("getGrowthMeasurement", false, s.getGrowthMeasurement)
	s.Register("getGrowthChart", false, s.getGrowthChart)
	for _, operation := range []string{"create", "update", "delete"} {
		op := operation
		s.Register(op+"GrowthMeasurement", false, func(ctx context.Context, r *Request) (Result, error) {
			return s.mutateGrowth(ctx, r, op)
		})
	}
}

// Only importer-proven, individually validated fields cross the legacy DTO
// boundary. Arbitrary archive metadata (including credentials) stays private.
func growthLegacyFields(row Object) Object {
	out := Object{}
	for _, key := range []string{"legacyDate", "legacyAgeInMonths", "legacyAgeLabel", "legacyPercentile", "legacyClientId", "legacyRecordedById", "legacySource", "legacySourceAgent"} {
		out[key] = nil
	}
	meta := obj(row["legacy_metadata"])
	date, ok := meta["legacyDate"].(string)
	if text(meta["sourceTable"]) != "GrowthMeasurement" || !ok || len(date) != 10 { return out }
	parsed, err := time.Parse("2006-01-02", date)
	if err != nil || parsed.Format("2006-01-02") != date { return out }
	out["legacyDate"] = date
	growth := obj(meta["legacyGrowth"])
	for target, source := range map[string]string{"legacyAgeInMonths":"ageInMonths", "legacyPercentile":"percentile"} {
		var number float64
		valid := false
		switch n := growth[source].(type) {
		case json.Number: number, err = n.Float64(); valid = err == nil
		case float64: number, valid = n, true
		case int: number, valid = float64(n), true
		case int64: number, valid = float64(n), true
		}
		if valid && !math.IsNaN(number) && !math.IsInf(number, 0) && math.Trunc(number) == number && number >= 0 && (target != "legacyPercentile" || number <= 100) { out[target] = number }
	}
	if value, ok := growth["ageLabel"].(string); ok { out["legacyAgeLabel"] = value }
	for _, key := range []string{"legacyClientId", "legacyRecordedById", "legacySource", "legacySourceAgent"} {
		if value, ok := meta[key].(string); ok { out[key] = value }
	}
	if value, ok := row["legacy_client_id"].(string); ok { out["legacyClientId"] = value }
	return out
}

func growthEntity(row Object) (Object, error) {
	out := Object{}
	for _, pair := range [][2]string{{"id","id"},{"familyId","family_id"},{"babyId","baby_id"},{"attachmentId","attachment_id"},{"notes","notes"},{"version","version"}} { out[pair[0]] = row[pair[1]] }
	for _, pair := range [][2]string{{"measurementDate","measurement_date"},{"createdAt","created_at"},{"updatedAt","updated_at"},{"deletedAt","deleted_at"}} { out[pair[0]] = isoValue(row[pair[1]]) }
	for _, field := range []struct{ wire, column string; precision int }{{"weightKg","weight_kg",2},{"heightCm","height_cm",1},{"headCircumferenceCm","head_circumference_cm",1}} {
		value, err := fixedJSDecimal(row[field.column], field.precision)
		if err != nil { return nil, err }
		out[field.wire] = value
	}
	for key, value := range growthLegacyFields(row) { out[key] = value }
	return out, nil
}

func growthDTO(entity Object) Object {
	out := Object{}
	for _, key := range []string{"id","babyId","familyId","weightKg","heightCm","headCircumferenceCm","attachmentId","notes","createdAt","updatedAt"} { out[key] = entity[key] }
	out["measurementDate"] = dateValue(entity["measurementDate"])
	out["version"] = text(entity["version"])
	if entity["legacyDate"] != nil {
		for _, key := range []string{"legacyDate","legacyAgeInMonths","legacyAgeLabel","legacyPercentile","legacyClientId","legacyRecordedById","legacySource","legacySourceAgent"} { out[key] = entity[key] }
	}
	return out
}

func growthRows(rows []Object) ([]Object, error) {
	out := make([]Object, 0, len(rows))
	for _, row := range rows {
		entity, err := growthEntity(row)
		if err != nil { return nil, err }
		out = append(out, growthDTO(entity))
	}
	return out, nil
}

func (s *Server) listGrowthMeasurements(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		args := []any{scope.FamilyID, scope.BabyID}
		where := "family_id=$1 AND baby_id=$2 AND deleted_at IS NULL"
		if before, id, valid := decodeCareCursor(r.HTTP.URL.Query().Get("cursor")); valid {
			args = append(args, before, id)
			where += " AND (measurement_date,id)<($3,$4)"
		}
		limit := pageLimit(r)
		args = append(args, limit+1)
		rows, err := many(ctx, q, "SELECT to_jsonb(g) FROM growth_measurements g WHERE "+where+" ORDER BY measurement_date DESC,id DESC LIMIT $"+strconv.Itoa(len(args)), args...)
		if err != nil { return Result{}, err }
		var next any
		if len(rows) > limit {
			rows = rows[:limit]
			last := rows[len(rows)-1]
			next = base64.RawURLEncoding.EncodeToString([]byte(text(dateValue(last["measurement_date"]))+"|"+text(last["id"])))
		}
		data, err := growthRows(rows)
		return Result{Status:200, Body:page(data,next)}, err
	})
}

func (s *Server) getGrowthMeasurement(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		row, err := one(ctx, q, "SELECT to_jsonb(g) FROM growth_measurements g WHERE family_id=$1 AND baby_id=$2 AND id=$3 AND deleted_at IS NULL", scope.FamilyID, scope.BabyID, r.Params["id"])
		if errors.Is(err, pgx.ErrNoRows) { return Result{}, notFound("growth_measurement",r.Params["id"]) }
		if err != nil { return Result{}, err }
		entity, err := growthEntity(row)
		if err != nil { return Result{}, err }
		return ok(growthDTO(entity))
	})
}

func (s *Server) getGrowthChart(ctx context.Context, r *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		scope, err := babyScope(ctx, q, r.Principal.UserID, r.Params["babyId"], false)
		if err != nil { return Result{}, err }
		var gender string
		if err = q.QueryRow(ctx,"SELECT gender FROM babies WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL",scope.BabyID,scope.FamilyID).Scan(&gender); err != nil { return Result{}, err }
		rows, err := many(ctx,q,"SELECT to_jsonb(g) FROM growth_measurements g WHERE family_id=$1 AND baby_id=$2 AND deleted_at IS NULL ORDER BY measurement_date ASC,id ASC",scope.FamilyID,scope.BabyID)
		if err != nil { return Result{}, err }
		measurements, err := growthRows(rows)
		if err != nil { return Result{}, err }
		standards, err := growthChartStandards(gender)
		if err != nil { return Result{}, err }
		return ok(Object{"measurements":measurements,"whoPercentiles":standards})
	})
}

func validateGrowthAttachment(ctx context.Context, tx pgx.Tx, id any, scope Scope) error {
	if id == nil { return nil }
	row, err := one(ctx,tx,"SELECT to_jsonb(a) FROM attachments a WHERE id=$1 FOR UPDATE",text(id))
	if errors.Is(err,pgx.ErrNoRows) { return notFound("Attachment",text(id)) }
	if err != nil { return err }
	if text(row["family_id"]) != scope.FamilyID { return apiError(403,"FAMILY_ACCESS_DENIED","Attachment belongs to another family") }
	if text(row["baby_id"]) != scope.BabyID { return apiError(403,"ATTACHMENT_ACCESS_DENIED","Attachment belongs to another baby") }
	if text(row["purpose"]) != "growth_photo" || !strings.HasPrefix(text(row["mime_type"]),"image/") || text(row["status"]) != "ready" || row["deleted_at"] != nil {
		return apiError(400,"INVALID_GROWTH_ATTACHMENT","Attachment must be a ready growth photo")
	}
	return nil
}

func growthValues(body Object, create bool) (Object,error) {
	values := Object{}
	for _, pair := range [][2]string{{"measurementDate","measurement_date"},{"weightKg","weight_kg"},{"heightCm","height_cm"},{"headCircumferenceCm","head_circumference_cm"},{"attachmentId","attachment_id"},{"notes","notes"}} {
		value, present := body[pair[0]]
		if !present && !create { continue }
		if value != nil {
			switch pair[0] {
			case "measurementDate":
				date, err := time.Parse("2006-01-02",text(value))
				if err != nil { return nil, invalid("Invalid measurementDate") }
				value = date
			case "weightKg","heightCm","headCircumferenceCm":
				var number pgtype.Numeric
				if err := number.Scan(text(value)); err != nil { return nil, invalid("Invalid growth decimal") }
				value = number
			}
		}
		values[pair[1]] = value
	}
	return values,nil
}

func growthChange(entity Object, operation string) (recordChange,error) {
	occurred,err := asTime(entity["measurementDate"])
	if err != nil { return recordChange{},err }
	payload := Object{"id":entity["id"],"version":entity["version"]}
	summary := "Deleted growth measurement: "+text(entity["id"])
	if operation == "delete" { payload["deletedAt"] = entity["deletedAt"] } else {
		for _, key := range []string{"measurementDate","weightKg","heightCm","headCircumferenceCm"} { payload[key]=entity[key] }
		payload["measurementDate"] = dateValue(entity["measurementDate"])
		parts := []string{}
		if entity["weightKg"] != nil { parts=append(parts,text(entity["weightKg"])+" kg") }
		if entity["heightCm"] != nil { parts=append(parts,text(entity["heightCm"])+" cm") }
		if entity["headCircumferenceCm"] != nil { parts=append(parts,"head "+text(entity["headCircumferenceCm"])+" cm") }
		summary="Growth: Recorded"
		if len(parts)>0 { summary="Growth: "+strings.Join(parts,", ") }
	}
	return recordChange{Entity:entity,Payload:payload,Summary:summary,OccurredAt:occurred},nil
}

func (s *Server) mutateGrowth(ctx context.Context, r *Request, operation string) (Result,error) {
	scope,err := babyScope(ctx,s.DB,r.Principal.UserID,r.Params["babyId"],true)
	if err != nil { return Result{},err }
	id,version := r.Params["id"],int64(0)
	if operation == "create" { id=newID() } else {
		raw := text(r.Body["baseVersion"])
		if operation == "delete" { raw=r.HTTP.URL.Query().Get("baseVersion") }
		version,err=careBaseVersion(careSpec{Kind:"growth"},operation,raw)
		if err != nil { return Result{},err }
	}
	key:=r.HTTP.Header.Get("Idempotency-Key")
	if key=="" {
		key=id
		if operation!="create" { key += "-"+strconv.FormatInt(version,10) }
	}
	key="growth-"+operation+"-"+key
	var hash string
	if operation=="delete" { hash,err=orderedHash("id",id,"baseVersion",version) } else { hash,err=scalarBodyHash(r) }
	if err != nil { return Result{},err }
	// Native receipts also bind the target scope, unlike the legacy body hash.
	digest,err:=orderedHash("hash",hash,"familyId",scope.FamilyID,"babyId",scope.BabyID,"operation",operation)
	if err != nil { return Result{},err }
	values,err:=growthValues(r.Body,operation=="create")
	if err != nil { return Result{},err }
	entity,err:=s.executeRecordCommand(ctx,r,recordCommand{
		Scope:scope,Kind:"growth",ID:id,Operation:operation,Key:key,RequestHash:hash,PayloadHash:digest,BaseVersion:version,
		Apply:func(ctx context.Context,tx pgx.Tx,_ Object,next int64)(recordChange,error){
			if operation!="delete" {
				if err:=validateGrowthAttachment(ctx,tx,r.Body["attachmentId"],scope); err!=nil { return recordChange{},err }
			}
			now:=time.Now().UTC()
			values["version"],values["updated_at"]=next,now
			var row Object
			var err error
			if operation=="create" {
				values["id"],values["family_id"],values["baby_id"],values["created_at"]=id,scope.FamilyID,scope.BabyID,now
				row,err=insertObject(ctx,tx,"growth_measurements",values)
			} else {
				if operation=="delete" { values=Object{"version":next,"updated_at":now,"deleted_at":now} }
				row,err=updateColumns(ctx,tx,"growth_measurements",id,values)
			}
			if err!=nil { return recordChange{},err }
			entity,err:=growthEntity(row)
			if err!=nil { return recordChange{},fmt.Errorf("growth projection: %w",err) }
			return growthChange(entity,operation)
		},
	})
	if err != nil { return Result{},err }
	if operation=="delete" { return ok(Object{"id":entity["id"],"deleted":true}) }
	if operation=="create" { return created(growthDTO(entity)) }
	return ok(growthDTO(entity))
}
