package backend

import (
	"encoding/json"
	"testing"
)

func TestSnapshotCanonicalKnownPayload(t *testing.T){
	value:=Object{"version":json.Number("1"),"babyId":"test_baby","notes":"test_记录\u2028<&>","weightKg":"9.40","nested":Object{"b":false,"a":nil}}
	raw,err:=snapshotJSON(value);if err!=nil{t.Fatal(err)}
	expected:="{\"babyId\":\"test_baby\",\"nested\":{\"a\":null,\"b\":false},\"notes\":\"test_记录\u2028<&>\",\"version\":1,\"weightKg\":\"9.40\"}"
	if string(raw)!=expected{t.Fatalf("unexpected canonical JSON: %s",raw)}
	first,err:=snapshotHash(value);if err!=nil{t.Fatal(err)}
	value["weightKg"]="9.41"
	second,err:=snapshotHash(value);if err!=nil||first==second{t.Fatal("changed content retained hash",err)}
}

func TestSnapshotPayloadMatchesPersistenceTypes(t *testing.T){
	row:=Object{"id":"id","family_id":"family","baby_id":"baby","measurement_date":"2026-05-01","weight_kg":json.Number("9.40"),"height_cm":nil,"created_at":"2026-05-01T12:00:00Z","version":json.Number("1")}
	payload:=snapshotPayload("growth",row)
	if payload["measurementDate"]!="2026-05-01T00:00:00.000Z"||payload["weightKg"]!="9.4"||payload["version"]!=json.Number("1"){t.Fatal(payload)}
	if snapshotPayload("food_plan",Object{"version":json.Number("9007199254740993")})["version"]!="9007199254740993"{t.Fatal("bigint precision lost")}
	if _,err:=snapshotTable("users; DROP TABLE users");err==nil{t.Fatal("unapproved table accepted")}
	before:=Object{"id":"id","version":json.Number("1"),"deletedAt":nil,"updatedAt":"old","notes":"same"}
	after:=Object{"id":"id","version":json.Number("2"),"deletedAt":"new","updatedAt":"new","notes":"same"}
	a,err:=snapshotHash(snapshotComparable(before));if err!=nil{t.Fatal(err)}
	b,err:=snapshotHash(snapshotComparable(after));if err!=nil||a!=b{t.Fatal("tombstone differences affected comparison")}
	after["notes"]="changed";b,err=snapshotHash(snapshotComparable(after));if err!=nil||a==b{t.Fatal("business mutation ignored")}
}

func TestNullableDeleteBodyIsNarrowlyScoped(t *testing.T){
	for _,raw:=range []string{"null"," {} "}{body,err:=decodeNativeBody("deleteRecordWithSnapshot",[]byte(raw));if err!=nil||body==nil||len(body)!=0{t.Fatal(raw,body,err)}}
	for _,operation:=range []string{"createGrowthMeasurement","createAiSession"}{if _,err:=decodeNativeBody(operation,[]byte("null"));err==nil{t.Fatal("null permitted on unrelated API")}}
	for _,raw:=range []string{"[]","42","{} {}","null true"}{if _,err:=decodeNativeBody("deleteRecordWithSnapshot",[]byte(raw));err==nil{t.Fatal("malformed body accepted",raw)}}
}
