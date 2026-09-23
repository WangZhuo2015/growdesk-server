package backend

import (
	"encoding/json"
	"strings"
	"testing"

	assets "github.com/WangZhuo2015/growdesk-server"
)

func TestGrowthProjectionKeepsDecimalAndNullableContract(t *testing.T) {
	row:=Object{"id":"record","family_id":"family","baby_id":"baby","measurement_date":"2026-09-23","weight_kg":json.Number("9.40"),"height_cm":json.Number("0.0"),"head_circumference_cm":nil,"attachment_id":nil,"notes":nil,"version":json.Number("2"),"created_at":"2026-09-23T01:00:00Z","updated_at":"2026-09-23T01:00:00Z","legacy_metadata":Object{"password":"must-not-leak","legacyDate":"2026-01-01"}}
	entity,err:=growthEntity(row)
	if err!=nil { t.Fatal(err) }
	dto:=growthDTO(entity)
	if dto["weightKg"]!="9.40" || dto["heightCm"]!="0.0" || dto["measurementDate"]!="2026-09-23" || dto["version"]!="2" { t.Fatalf("bad DTO: %#v",dto) }
	if v,exists:=dto["headCircumferenceCm"]; !exists || v!=nil { t.Fatal("nullable field lost") }
	if _,exists:=dto["legacyDate"]; exists { t.Fatal("unproven legacy metadata promoted") }
	raw,_:=jsonText(dto)
	if strings.Contains(raw,"must-not-leak") || strings.Contains(raw,"legacy_metadata") || strings.Contains(raw,"deletedAt") { t.Fatal("private fields leaked") }
}

func TestGrowthImportedMetadataWhitelist(t *testing.T) {
	row:=Object{"legacy_client_id":"source-id","legacy_metadata":Object{"sourceTable":"GrowthMeasurement","legacyDate":"2026-02-28","legacyClientId":"other","password":"private","legacyGrowth":Object{"ageInMonths":json.Number("0"),"ageLabel":"test_初生","percentile":json.Number("100")}}}
	fields:=growthLegacyFields(row)
	if fields["legacyDate"]!="2026-02-28" || fields["legacyClientId"]!="source-id" || fields["legacyAgeInMonths"]!=float64(0) || fields["legacyPercentile"]!=float64(100) { t.Fatalf("metadata mismatch: %#v",fields) }
	meta:=obj(row["legacy_metadata"])
	meta["legacyDate"]="2026-02-30"
	if growthLegacyFields(row)["legacyDate"]!=nil { t.Fatal("invalid calendar date accepted") }
	meta["legacyDate"]="2026-02-28"
	meta["legacyGrowth"]=Object{"ageInMonths":"2","percentile":json.Number("101")}
	if fields=growthLegacyFields(row); fields["legacyAgeInMonths"]!=nil || fields["legacyPercentile"]!=nil { t.Fatal("invalid imported scalar promoted") }
}

func TestGrowthReferenceSeriesAndCopies(t *testing.T) {
	if _,err:=parseGrowthReference(string(assets.GrowthStandardsSource)); err!=nil { t.Fatal(err) }
	male,err:=growthChartStandards("boy")
	if err!=nil { t.Fatal(err) }
	female,err:=growthChartStandards("girl")
	if err!=nil { t.Fatal(err) }
	for _,key:=range []string{"weightForAge","heightForAge","headCircumferenceForAge"} {
		if len(male[key].([]Object))!=37 || len(female[key].([]Object))!=37 { t.Fatal("missing series point") }
	}
	if male["weightForAge"].([]Object)[0]["p50"]!="3.30" || female["heightForAge"].([]Object)[0]["p50"]!="49.1" { t.Fatal("reference precision or sex mismatch") }
	male["weightForAge"].([]Object)[0]["p50"]="changed"
	again,err:=growthChartStandards("male")
	if err!=nil || again["weightForAge"].([]Object)[0]["p50"]!="3.30" { t.Fatal("caller mutated shared reference") }
	if _,err=parseGrowthReference("incomplete snapshot"); err==nil { t.Fatal("missing reference fabricated") }
}

func TestGrowthPatchDistinguishesOmissionAndNull(t *testing.T) {
	values,err:=growthValues(Object{"heightCm":nil},false)
	if err!=nil || len(values)!=1 { t.Fatal(values,err) }
	if _,exists:=values["weight_kg"]; exists { t.Fatal("omitted value was cleared") }
	if value,exists:=values["height_cm"]; !exists || value!=nil { t.Fatal("explicit null was ignored") }
}
