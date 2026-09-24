// Versioned reference rules copied from the legacy production vaccine dataset.
// Keep these immutable and pin their canonical hash in the reference golden.
export const vaccineEngineRules: Record<string, unknown>[] = [
  {
    id: "rule_rotavirus_exclusive",
    type: "mutually_exclusive_product_series",
    vaccineIds: ["vac_rotavirus_llr", "vac_rotavirus3", "vac_rotavirus5", "vac_rotavirus6"],
    description: "默认不把不同轮状病毒产品叠加成一套程序；互换仅依据具体说明书/指南。",
    sourceRefs: ["src_chinacdc_nonprogram_principle_2020", "src_hebeicdc_rotavirus_2025"],
  },
  {
    id: "rule_pcv13_product_specific",
    type: "product_specific_regimen",
    vaccineIds: ["vac_pcv13_crm197", "vac_pcv13_tt", "vac_pcv13_ttdt", "vac_pcv13_crm197_tt_cansino"],
    description: "PCV13载体/产品不同，起始年龄、间隔和补种程序可能不同；先选产品再排程序。",
    sourceRefs: ["src_guangdong_non_nip_2024", "src_pcv13i_cansino_2026"],
  },
  {
    id: "rule_pertussis_combo_component_counting",
    type: "component_counting",
    vaccineIds: ["vac_dtap_hib", "vac_dtap_ipv_hib_pentaxim"],
    description: "含百日咳成分非免规疫苗按说明书接种可计入DTaP；含IPV成分可计入脊灰。",
    sourceRefs: ["src_nip_2026", "src_chinacdc_pertussis_2026"],
  },
  {
    id: "rule_pentaxim_no_auto_same_day",
    type: "coadministration_constraint",
    vaccineIds: ["vac_dtap_ipv_hib_pentaxim"],
    description: "潘太欣中国说明书暂建议不与其他儿童计划免疫/常规儿童疫苗同时接种；自动排期不得默认同日。",
    sourceRefs: ["src_pentaxim_pi_2024"],
  },
  {
    id: "rule_ev71_recheck_same_day",
    type: "coadministration_requires_revalidation",
    vaccineIds: ["vac_ev71"],
    description: "EV-A71旧专项技术指南的同时接种规则较保守；接种前按当前产品说明书/门诊复核。",
    sourceRefs: ["src_ev71_guide", "src_chinacdc_nonprogram_principle_2020"],
  },
  {
    id: "rule_jiangsu_varicella_free",
    type: "regional_program_override",
    vaccineIds: ["vac_varicella"],
    description: "江苏/苏州水痘按地方免费项目显示，不能默认标成自费。",
    sourceRefs: ["src_suzhou_varicella_2026", "src_jiangsu_varicella_evaluation_2025"],
  },
  {
    id: "rule_meningococcal_no_automatic_substitution",
    type: "substitution_requires_local_policy",
    vaccineIds: ["vac_mcv_ac", "vac_mcv4_crm197", "vac_mpsv_acyw_highrisk"],
    description: "自费流脑结合/四价疫苗与国家MPSV-A/MPSV-AC的替代计次，在缺少江苏2026明确逐剂映射时不自动计算。",
    sourceRefs: ["src_chinacdc_nonprogram_principle_2020", "src_chinacdc_meningococcal_2026"],
  },
  {
    id: "rule_indication_specific_not_routine",
    type: "exclude_from_routine_timeline",
    vaccineIds: ["vac_ppsv23_highrisk", "vac_mpsv_acyw_highrisk", "vac_rabies_pep"],
    description: "仅在高危、旅行或暴露等具体指征出现时生成，不进入健康儿童默认常规时间轴。",
    sourceRefs: ["src_guangdong_non_nip_2024", "src_rabies_2023"],
  },
];
