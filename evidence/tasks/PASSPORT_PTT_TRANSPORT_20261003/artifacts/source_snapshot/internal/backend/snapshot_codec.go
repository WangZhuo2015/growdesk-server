package backend

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var snapshotTables = map[string]string{
	"feeding":"feeding_records", "sleep":"sleep_records", "diaper":"diaper_records",
	"food":"food_records", "growth":"growth_measurements", "medical_report":"medical_reports",
	"vaccine":"vaccine_records", "supplement":"supplement_records", "food_plan":"baby_food_plans",
}

func snapshotTable(kind string)(string,error){
	table,ok:=snapshotTables[kind]
	if !ok { return "",apiError(422,"UNSUPPORTED_SNAPSHOT_ENTITY","Unsupported record snapshot entity") }
	return table,nil
}

// Canonicalization follows the reference's recursive English locale key
// ordering. Each call owns its collator and buffers; neither is shared across
// requests. JSON scalars use the existing JavaScript-compatible quoting path.
func snapshotJSON(value any)([]byte,error){
	collator:=collate.New(language.English)
	var encode func(any,int)([]byte,error)
	encode=func(value any,depth int)([]byte,error){
		if depth>64 { return nil,apiError(409,"SNAPSHOT_INVALID_PAYLOAD","Snapshot nesting is too deep") }
		if object:=obj(value);object!=nil {
			keys:=sortedKeys(object)
			sort.SliceStable(keys,func(i,j int)bool{return collator.CompareString(keys[i],keys[j])<0})
			var b bytes.Buffer;b.WriteByte('{')
			for i,key:=range keys {
				if i>0 { b.WriteByte(',') }
				encoded,err:=receiptJSON(key);if err!=nil{return nil,err};b.Write(encoded);b.WriteByte(':')
				encoded,err=encode(object[key],depth+1);if err!=nil{return nil,err};b.Write(encoded)
				if b.Len()>16000000{return nil,apiError(409,"SNAPSHOT_INVALID_PAYLOAD","Snapshot exceeds the size budget")}
			}
			b.WriteByte('}');return b.Bytes(),nil
		}
		if items,ok:=value.([]any);ok {
			var b bytes.Buffer;b.WriteByte('[')
			for i,item:=range items{if i>0{b.WriteByte(',')};encoded,err:=encode(item,depth+1);if err!=nil{return nil,err};b.Write(encoded);if b.Len()>16000000{return nil,errors.New("snapshot size budget exceeded")}}
			b.WriteByte(']');return b.Bytes(),nil
		}
		if number,ok:=value.(json.Number);ok {
			n,err:=number.Float64();if err!=nil||math.IsNaN(n)||math.IsInf(n,0){return nil,errors.New("invalid snapshot number")}
			if n==0{n=0};return jsonBytes(n)
		}
		return receiptJSON(value)
	}
	return encode(value,0)
}

func snapshotHash(value any)(string,error){raw,err:=snapshotJSON(value);if err!=nil{return "",err};return hashText(string(raw)),nil}

// A Prisma row is not the public record DTO: Decimal fields become strings,
// DATE columns become midnight ISO timestamps, and food-plan bigint versions
// stay strings. Metadata is copied as data, never used for authorization.
func snapshotPayload(kind string,row Object) Object {
	result:=Object{}
	decimalColumns:=map[string]bool{}
	switch kind {
	case "feeding":decimalColumns["amount_ml"]=true
	case "supplement":decimalColumns["dose"]=true
	case "growth":decimalColumns["weight_kg"],decimalColumns["height_cm"],decimalColumns["head_circumference_cm"]=true,true,true
	}
	dateColumns:=map[string]bool{}
	switch kind {
	case "growth":dateColumns["measurement_date"]=true
	case "medical_report":dateColumns["report_date"]=true
	case "vaccine":dateColumns["administered_date"],dateColumns["scheduled_date"],dateColumns["completed_date"]=true,true,true
	}
	for column,value:=range row {
		if strings.HasSuffix(column,"_at")||dateColumns[column]{value=isoValue(value)}
		if decimalColumns[column]{value=decimalValue(value)}
		if kind=="food_plan"&&column=="version"{value=text(value)}
		result[camelColumn(column)]=value
	}
	return result
}

func snapshotComparable(value any)any{
	if object:=obj(value);object!=nil{
		result:=Object{}
		for key,item:=range object{switch key{case "deletedAt","updatedAt","version","restoredAt":continue};result[key]=snapshotComparable(item)}
		return result
	}
	if items,ok:=value.([]any);ok{result:=make([]any,len(items));for i,item:=range items{result[i]=snapshotComparable(item)};return result}
	return value
}

func recordSnapshotDTO(row Object)Object{
	out:=Object{}
	for _,pair:=range [][2]string{{"id","id"},{"familyId","family_id"},{"babyId","baby_id"},{"userId","user_id"},{"source","source"},{"sourceAgent","source_agent"},{"action","action"},{"entityType","entity_type"},{"entityId","entity_id"},{"payload","payload_json"},{"payloadHash","payload_hash"},{"sourceSystem","source_system"},{"sourceBatchId","source_batch_id"},{"sourceTable","source_table"},{"sourceId","source_id"},{"sourceHash","source_hash"},{"mappingVersion","mapping_version"},{"restored","restored"}}{out[pair[0]]=row[pair[1]]}
	out["restoredAt"],out["createdAt"]=isoValue(row["restored_at"]),isoValue(row["created_at"])
	return out
}
