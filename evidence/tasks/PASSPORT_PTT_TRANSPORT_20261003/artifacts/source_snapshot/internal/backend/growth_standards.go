package backend

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"

	assets "github.com/WangZhuo2015/growdesk-server"
)

type growthReferenceSeries struct {
	Male, Female [3][5][37]json.Number
}

var growthReferenceOnce sync.Once
var growthReferenceData growthReferenceSeries
var growthReferenceError error

// Parse only the narrowly defined, frozen arrays. No code is evaluated. A
// missing/extra point fails closed instead of returning fabricated zero curves.
func parseGrowthReference(source string) (growthReferenceSeries,error) {
	var result growthReferenceSeries
	male:=strings.Index(source,"export const WHO_STANDARDS_BOYS")
	female:=strings.Index(source,"export const WHO_STANDARDS_GIRLS")
	end:=strings.Index(source,"export function getWhoStandard")
	if male<0 || female<=male || end<=female { return result,errors.New("growth reference sections missing") }
	sections:=[]string{source[male:female],source[female:end]}
	seriesPattern:=regexp.MustCompile(`(?s)P(?:97|85|50|15|3):\s*(\[[^\]]*\])`)
	for sex,section:=range sections {
		matches:=seriesPattern.FindAllStringSubmatch(section,-1)
		if len(matches)!=15 { return result,errors.New("growth reference must have fifteen series") }
		for series,match:=range matches {
			var values []json.Number
			if err:=decodeJSON([]byte(match[1]),&values); err!=nil { return result,err }
			if len(values)!=37 { return result,errors.New("growth series must have thirty-seven points") }
			for month,value:=range values {
				if _,err:=fixedJSDecimal(value,2); err!=nil { return result,err }
				if sex==0 { result.Male[series/5][series%5][month]=value } else { result.Female[series/5][series%5][month]=value }
			}
		}
	}
	return result,nil
}

func growthChartStandards(gender string)(Object,error){
	growthReferenceOnce.Do(func(){ growthReferenceData,growthReferenceError=parseGrowthReference(string(assets.GrowthStandardsSource)) })
	if growthReferenceError!=nil { return nil,growthReferenceError }
	series:=growthReferenceData.Female
	if gender=="boy" || gender=="male" { series=growthReferenceData.Male }
	out:=Object{}
	for metric,name:=range []string{"weightForAge","heightForAge","headCircumferenceForAge"} {
		precision:=1
		if metric==0 { precision=2 }
		points:=make([]Object,37)
		for month:=0;month<37;month++ {
			point:=Object{"monthAge":month}
			for percentile,key:=range []string{"p97","p85","p50","p15","p3"} {
				value,err:=fixedJSDecimal(series[metric][percentile][month],precision)
				if err!=nil { return nil,err }
				point[key]=value
			}
			points[month]=point
		}
		out[name]=points
	}
	return out,nil
}
