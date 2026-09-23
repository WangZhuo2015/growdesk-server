package backend

import "context"

func vaccinePublicFields(row Object, columns ...string) Object {
	value := Object{}
	for _, column := range columns { value[camelColumn(column)] = row[column] }
	return value
}

func vaccineCatalogItem(row Object) Object {
	value := vaccinePublicFields(row, "id", "vaccine_code", "name", "short_name", "english_name", "program_type", "legacy_label", "sex_restriction", "china_national", "diseases", "target_population", "policy_effective_date", "policy_version", "routine_healthy_child_option", "manual_review_required", "market_status", "product_brand_name", "product_manufacturer", "product_approval_number", "jiangsu_notes", "suzhou_notes", "catch_up_supported", "catch_up_rules", "simultaneous_vaccination", "substitution_rules", "contraindications", "precautions", "special_populations", "regional_overrides", "regimen_options", "source_refs_json")
	doses := make([]Object, 0)
	if raw, ok := row["doses"].([]any); ok {
		for _, item := range raw {
			dose := obj(item)
			projected := vaccinePublicFields(dose, "id", "vaccine_id", "dose_number", "dose_label", "recommended_age_months", "minimum_age_days", "maximum_age_days", "recommended_age_max_months", "minimum_interval_days_from_previous", "maximum_interval_days_from_previous", "route", "site", "notes", "source_refs_json")
			projected["doseVolumeMl"] = decimalValue(dose["dose_volume_ml"])
			doses = append(doses, projected)
		}
	}
	value["doses"] = doses
	return value
}

func (s *Server) getVaccineCatalog(ctx context.Context, _ *Request) (Result, error) {
	return s.readSnapshot(ctx, func(q Querier) (Result, error) {
		vaccines, err := many(ctx, q, `SELECT to_jsonb(v) || jsonb_build_object('doses',COALESCE(
			(SELECT jsonb_agg(to_jsonb(d) ORDER BY dose_number) FROM vaccine_doses d WHERE d.vaccine_id=v.id),'[]'::jsonb))
			FROM vaccines v ORDER BY vaccine_code`)
		if err != nil { return Result{}, err }
		groups, err := many(ctx, q, "SELECT to_jsonb(g) FROM vaccine_strategy_groups g ORDER BY strategy_id")
		if err != nil { return Result{}, err }
		entries, err := many(ctx, q, "SELECT to_jsonb(e) FROM vaccine_schedule_entries e ORDER BY age_months,dose_number,id")
		if err != nil { return Result{}, err }
		national, provincial, nonProgram := make([]Object, 0), make([]Object, 0), make([]Object, 0)
		for _, row := range vaccines {
			value := vaccineCatalogItem(row)
			switch text(row["program_type"]) {
			case "national_immunization_program": national = append(national, value)
			case "provincial_immunization_program": provincial = append(provincial, value)
			case "non_program": nonProgram = append(nonProgram, value)
			}
		}
		strategies := make([]Object, 0, len(groups))
		for _, row := range groups { strategies = append(strategies, vaccinePublicFields(row, "id", "strategy_id", "vaccine_id", "name", "scope", "base_program", "options_json", "source_refs_json")) }
		schedule := make([]Object, 0, len(entries))
		for _, row := range entries { schedule = append(schedule, vaccinePublicFields(row, "id", "vaccine_id", "age_months", "age_days", "age_label", "dose_number", "priority", "is_optional", "action", "selection_group", "notes", "source_refs_json")) }
		reference, err := loadReferenceCatalogs()
		if err != nil { return Result{}, err }
		release, err := cloneJSON(reference.DataRelease)
		if err != nil { return Result{}, err }
		return Result{Status: 200, Body: Object{"national": national, "nonProgram": nonProgram, "provincial": provincial,
			"strategyGroups": strategies, "schedule": schedule, "engineRules": nativeVaccineEngineRules(), "dataRelease": release}}, nil
	})
}

func (s *Server) getVaccineSchedule(ctx context.Context, _ *Request) (Result, error) {
	rows, err := many(ctx, s.DB, "SELECT to_jsonb(v) FROM vaccine_schedules v ORDER BY recommended_age_months,dose_number")
	if err != nil { return Result{}, err }
	if len(rows) == 0 { return ok(defaultVaccineSchedule()) }
	data := make([]Object, 0, len(rows))
	for _, row := range rows { data = append(data, vaccinePublicFields(row, "id", "vaccine_code", "name", "recommended_age_months", "dose_number", "mandatory")) }
	return ok(data)
}

// These fallback rows are the frozen reference's behavior, not newly authored
// medical guidance. The real HTTP differential checks every returned field.
func defaultVaccineSchedule() []Object {
	type row struct { id, code, name string; month, dose int }
	rows := []row{
		{"sched-bcg-1", "BCG", "卡介苗", 0, 1},
		{"sched-hepb-1", "HepB", "乙肝疫苗 (第1剂)", 0, 1},
		{"sched-hepb-2", "HepB", "乙肝疫苗 (第2剂)", 1, 2},
		{"sched-ipv-1", "IPV", "脊灰灭活疫苗 (第1剂)", 2, 1},
		{"sched-dtap-1", "DTaP", "百白破疫苗 (第1剂)", 3, 1},
		{"sched-dtap-2", "DTaP", "百白破疫苗 (第2剂)", 4, 2},
		{"sched-dtap-3", "DTaP", "百白破疫苗 (第3剂)", 5, 3},
		{"sched-hepb-3", "HepB", "乙肝疫苗 (第3剂)", 6, 3},
		{"sched-mmr-1", "MMR", "麻腮风疫苗 (第1剂)", 8, 1},
	}
	result := make([]Object, 0, len(rows))
	for _, item := range rows { result = append(result, Object{"id": item.id, "vaccineCode": item.code, "name": item.name, "recommendedAgeMonths": item.month, "doseNumber": item.dose, "mandatory": true}) }
	return result
}

// Pinned to apps/api/src/knowledge/vaccine-engine-rules.ts at ReferenceCommit.
// New slices/maps per call prevent responses from mutating the reference data.
func nativeVaccineEngineRules() []Object {
	return []Object{
		{"id": "rule_rotavirus_exclusive", "type": "mutually_exclusive_product_series", "vaccineIds": []string{"vac_rotavirus_llr", "vac_rotavirus3", "vac_rotavirus5", "vac_rotavirus6"}, "description": "默认不把不同轮状病毒产品叠加成一套程序；互换仅依据具体说明书/指南。", "sourceRefs": []string{"src_chinacdc_nonprogram_principle_2020", "src_hebeicdc_rotavirus_2025"}},
		{"id": "rule_pcv13_product_specific", "type": "product_specific_regimen", "vaccineIds": []string{"vac_pcv13_crm197", "vac_pcv13_tt", "vac_pcv13_ttdt", "vac_pcv13_crm197_tt_cansino"}, "description": "PCV13载体/产品不同，起始年龄、间隔和补种程序可能不同；先选产品再排程序。", "sourceRefs": []string{"src_guangdong_non_nip_2024", "src_pcv13i_cansino_2026"}},
		{"id": "rule_pertussis_combo_component_counting", "type": "component_counting", "vaccineIds": []string{"vac_dtap_hib", "vac_dtap_ipv_hib_pentaxim"}, "description": "含百日咳成分非免规疫苗按说明书接种可计入DTaP；含IPV成分可计入脊灰。", "sourceRefs": []string{"src_nip_2026", "src_chinacdc_pertussis_2026"}},
		{"id": "rule_pentaxim_no_auto_same_day", "type": "coadministration_constraint", "vaccineIds": []string{"vac_dtap_ipv_hib_pentaxim"}, "description": "潘太欣中国说明书暂建议不与其他儿童计划免疫/常规疫苗同时接种；自动排期不得默认同日。", "sourceRefs": []string{"src_pentaxim_pi_2024"}},
		{"id": "rule_ev71_recheck_same_day", "type": "coadministration_requires_revalidation", "vaccineIds": []string{"vac_ev71"}, "description": "EV-A71旧专项技术指南的同时接种规则较保守；接种前按当前产品说明书/门诊复核。", "sourceRefs": []string{"src_ev71_guide", "src_chinacdc_nonprogram_principle_2020"}},
		{"id": "rule_jiangsu_varicella_free", "type": "regional_program_override", "vaccineIds": []string{"vac_varicella"}, "description": "江苏/苏州水痘按地方免费项目显示，不能默认标成自费。", "sourceRefs": []string{"src_suzhou_varicella_2026", "src_jiangsu_varicella_evaluation_2025"}},
		{"id": "rule_meningococcal_no_automatic_substitution", "type": "substitution_requires_local_policy", "vaccineIds": []string{"vac_mcv_ac", "vac_mcv4_crm197", "vac_mpsv_acyw_highrisk"}, "description": "自费流脑结合/四价疫苗与国家MPSV-A/MPSV-AC的替代计次，在缺少江苏2026明确逐剂映射时不自动计算。", "sourceRefs": []string{"src_chinacdc_nonprogram_principle_2020", "src_chinacdc_meningococcal_2026"}},
		{"id": "rule_indication_specific_not_routine", "type": "exclude_from_routine_timeline", "vaccineIds": []string{"vac_ppsv23_highrisk", "vac_mpsv_acyw_highrisk", "vac_rabies_pep"}, "description": "仅在高危、旅行或暴露等具体指征出现时生成，不进入健康儿童默认常规时间轴。", "sourceRefs": []string{"src_guangdong_non_nip_2024", "src_rabies_2023"}},
	}
}
