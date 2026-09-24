# Cloud business import gap audit

审计状态：READ_ONLY_AUDIT（2026-09-19）。本报告只检查仓库代码、版本化迁移、既有聚合证据和当前工作树中的云导入脚本；没有连接生产数据库、旧生产 SQLite、3088，亦没有读取 secrets。没有修改既有脚本或业务实现。

## 结论

仓库目前有一个可重放的 identity-v1 + raw archive 导入器，不存在可以把旧 Web 业务历史 materialize 到 GrowDesk 正式业务表的云 ETL。scripts/legacy-import/import_sql.py 对所有非核心表只写 legacy_import.import_rows 的原文和 hash；正式表只写 User、Family、Baby、FamilyMember 以及派生 BabyMember。目标服务的 feeding、sleep、diaper、food、growth、medical、supplement、vaccine、food plan、formula product 运行时表和 service 已存在，但它们不是旧数据 materializer。

因此，当前部署证据只能证明身份和原始档案保存成功，不能证明旧用户的照护历史已能在新 API 中读取。既有 target verification 明确返回 businessHistoryReady: false；这应继续阻断生产无缝切换。

## 导入器本身的证据

| 检查项 | 证据 | 判断 |
|---|---|---|
| mapping 范围 | scripts/legacy-import/import_sql.py:68-75 固定 mapping_version='identity-v1'，逐表逐行写 source_table/source_id/payload/payload_hash；没有按业务表分支 | 只保存原文，没有 typed business mapper |
| 正式表写入范围 | scripts/legacy-import/import_sql.py:76-89 只插入 public.users、families、babies、family_members、sync states 和 baby_members | 没有任何记录、产品、计划、疫苗选择或附件对象的正式写入 |
| 字段校验范围 | scripts/legacy-import/import_sql.py:43-57 只校验核心表存在、Baby 所属 Family、生日、成员角色、管理员和 bcrypt 前缀；没有业务日期、decimal、JSON、枚举、FK、软删或 timeline 校验 | 原始行可以被完整存档，但不能据此认为目标字段兼容 |
| 原文档案模型 | prisma/migrations/202609120001_identity/migration.sql:124-156 只有 legacy_import.import_batches/import_rows；source_table/source_id/payload/payload_hash 是 lineage/archive 字段；:231-236 撤销了 PUBLIC 对 archive/public 表的权限 | archive 不是正式业务表 |
| 重复执行 | scripts/legacy-import/import_sql.py:91-107 使用 advisory transaction lock、同 batch 行数检查和空身份库拒绝；scripts/legacy-import/test_import_integration.py:36-54 验证原子回滚、同 batch 重放和 changed batch 拒绝 | 只保护 identity/raw batch；没有逐业务实体 promotion receipt 或增量 reconcile |
| 实际验收范围 | scripts/legacy-import/verify_target.py:15-33 只比对 raw archive、用户和 BabyMember，返回 businessHistoryReady=False；evidence/tasks/LEGACY_IMPORT/target-verification.json:14-19 记录同样结果 | 没有业务历史可读性证明 |
| 部署入口 | deploy/import-legacy-target.py:46-55 只运行 migrations、import_sql.py 和 verify_target.py | 没有后续 domain ETL/materializer 阶段 |

## 旧快照的实际业务行数

evidence/tasks/LEGACY_IMPORT/source-inventory.json:6-46 是脱敏聚合清单，记录了需要转换的业务数据：FeedingRecord 84、SleepRecord 48、DiaperRecord 48、FoodItem 50、FoodLogRecord 14、FamilyFoodStatus 6、FoodPlan 0、FormulaProduct 2、GrowthMeasurement 7、MedicalReport 2、SupplementProduct 3、SupplementRecord 24、SupplementSchedule 3、Vaccine 33、VaccineDose 58、VaccineRecord 5、VaccineScheduleEntry 51、VaccineSelection 4、VaccineStrategyGroup 3。另有 29 个附件文件（:57-59），但当前没有引用到目标 Attachment 的对账证据。

## 逐领域结论

“canonical runtime”列只证明新服务可以处理新写入或已 materialized 的新数据，不证明它读取 legacy_import。除非另有说明，每行的“重放/校验”结论均为：没有业务级保护；只有上面 identity-v1 的 batch-level raw replay guard。

| 领域 / 旧源模型及数量 | 当前正式模型或运行路径 | 业务导入、数量/字段校验、重复保护 | 状态与生产缺口 |
|---|---|---|---|
| Feeding / FeedingRecord 84 | prisma/schema.prisma:440-468；apps/api/src/services/feeding-service.ts:75-316 | 未发现 legacy_import 到 feeding_records 的 mapper；没有 84→目标行 count、ID/FK、时间/奶量/来源/作者/营养快照校验，也没有 promotion receipt | 仅存档（canonical runtime exists，无历史 materializer） |
| Sleep / SleepRecord 48 | prisma/schema.prisma:522-545；apps/api/src/services/sleep-service.ts:70-285 | 没有旧 startedAt/endedAt/nightWakingCount 转换、跨午夜/未结束校验或业务行重放保护 | 仅存档 |
| Diaper / DiaperRecord 48 | prisma/schema.prisma:497-520；apps/api/src/services/diaper-service.ts:70-265 | 没有 diaperType/poopColor/poopConsistency/notes 的旧字段映射、枚举/时间/FK/count 对账或业务幂等导入 | 仅存档 |
| Food / FoodItem 50、FoodLogRecord 14、FamilyFoodStatus 6、FoodPlan 0 | prisma/schema.prisma:547-617；prisma/migrations/202609120006_care_food/migration.sql:1-78；apps/api/src/services/food-service.ts:117-434 | 202609190015_food_reference_seed/migration.sql:1-52 是版本化公共参考目录，不是旧家庭数据 ETL；没有 FoodLogRecord、FamilyFoodStatus 或 FoodPlan promotion。FoodPlan 源计数为 0，不能被写成已迁移 | 仅存档（公共 reference seed 另行存在）；旧家庭食物状态/辅食日志未 materialize |
| Growth / GrowthMeasurement 7 | prisma/schema.prisma:640-661；apps/api/src/services/growth-service.ts:70-233 | 没有旧 date/weight/height/head-circumference 的 date/numeric 转换、图片引用映射、WHO/timeline projection 或 7 行对账 | 仅存档 |
| Medical / MedicalReport 2 | prisma/schema.prisma:691-732；prisma/migrations/202609120010_attachments_medical_vaccines/migration.sql:1-68；apps/api/src/services/medical-service.ts:33-473 | 没有旧报告 date/items/诊断字段 JSONB 转换、caregiver 归属、timeline projection 或附件引用 hash/size/ACL 对账；29 个归档文件未建立目标 Attachment map | 仅存档；病历和图片切换前必须做完整对象对账 |
| Supplement / SupplementProduct 3、SupplementRecord 24、SupplementSchedule 3 | 当前 schema 只有 SupplementRecord（prisma/schema.prisma:619-637）；apps/api/src/services/supplement-service.ts:63-254 只覆盖实际服用记录 | 没有 SupplementProduct/SupplementSchedule canonical model 或旧产品/计划 mapper；没有 dosage/date/time/JSON/count/FK 校验或业务重放 | 仅存档；产品/计划历史没有目标承载 |
| Vaccine / Vaccine 33、VaccineDose 58、VaccineScheduleEntry 51、VaccineStrategyGroup 3、VaccineRecord 5 | 当前 schema 只有 VaccineSchedule 和 VaccineRecord（prisma/schema.prisma:734-770）；apps/api/src/services/vaccine-service.ts:11-126 还包含新的少量 default schedule fallback | default schedule 是新代码静态 fallback，不是 33/58/51/3 条旧 reference 的导入；没有旧 vaccine policy/source/version/最大间隔等字段映射、数量/FK/日期校验或业务 promotion | 仅存档；现有接种记录和完整策略资料不会从 archive 自动出现 |
| Food plan / FoodPlan 0 | BabyFoodPlan 在 prisma/schema.prisma:603-617，读写路径为 apps/api/src/services/food-service.ts:388-434，版本迁移为 prisma/migrations/202609190016_food_plan_version/migration.sql:1-3 | 源快照没有 FoodPlan 行；没有“零行”之外的 source-to-target 证明，也没有 importer。新 CAS 只保护新写入计划，不能证明旧历史转换 | 无实现（源计数为 0）；应保留明确的 zero-source 结论 |
| Formula product / FormulaProduct 2 | prisma/schema.prisma:470-495；packages/database/src/formula-product-repository.ts:75-224；apps/api/src/services/formula-product-service.ts:37-112 | 没有旧 brand/name/stage/ratio/nutrients/active/default/archive 字段映射、family FK/count/hash 或产品历史 promotion；运行时分页/归属检查只适用于新 PG 行 | 仅存档；旧奶粉产品及其 feeding 引用仍缺 materialization |
| Vaccine selection / VaccineSelection 4 | prisma/schema.prisma 没有该模型；当前 app/packages/prisma 中没有对应 route/service/repository。目标计划仍把它列为待实现模型（docs/plan/implementation/03_DATABASE_MIGRATION.md:93-95、04_FEATURE_PARITY_AND_IOS.md:98） | 只有 archive raw rows；没有 (babyId,vaccineId,doseNumber) 目标唯一约束、选择状态映射、数量/FK/版本校验或重复执行保护 | 无实现；这是明确的目标 schema/ETL 缺口，不能依赖 legacy_import 在线读取 |

## 额外风险：孕周单位修复不覆盖既有批次

当前工作树中 scripts/legacy-import/import_sql.py:28-36,84 已加入旧 Web 孕周（weeks）到 canonical gestational_age（days）的 ×7 转换，scripts/legacy-import/test_import_integration.py:44-45 增加了 38→266 和 null 的隔离断言。这是未来生成 SQL 的修复，未改变已存在的 target rows；evidence/tasks/LEGACY_IMPORT/target-verification.json:2-18 仍是 2026-09-12 的既有身份批次证据。因此，若该批次曾导入非空 gestationalAge，必须在隔离环境用 archive source hash/值与目标 Baby 逐行核对，不能默认旧批次已经被本次修复覆盖，也不应在没有对账前直接改生产数据。

## 切换前必须补齐的工作

1. 在 legacy_import 之外实现版本化 typed domain ETL/promotion：至少覆盖上表各模型，保留源 ID、source hash、mapping version、目标 ID/hash、结果和 quarantine 原因；每次 promotion 写 receipt。
2. 先冻结目标 schema 缺口：VaccineSelection、SupplementProduct、SupplementSchedule 以及旧 vaccine reference 的 policy/source/strategy/dose 字段；不能用新静态 fallback 冒充旧资料。
3. 为每个领域生成并验收 count、ID 集合、FK/家庭宝宝归属、date/timezone、numeric、JSON、enum、软删除、作者和 timeline 对账；医疗与成长还要完成附件 hash/size/ACL 对账。
4. 增加可重跑且支持新增/更新/删除差异的 reconcile 流程。当前 importer 的空身份库拒绝（scripts/legacy-import/import_sql.py:106-107）应保留，不能为增量导入简单删除保护后 upsert。
5. 完成一次隔离 PG 的全量演练和最终差异报告后，才能进入停写、shadow read 和切换门禁。计划 09 已明确 raw archive 不能作为在线查询来源，并要求 typed mapper/promotion receipt（docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md:246-260）；计划 03 将 DB08/DB10/DB11/DB12-15 作为生产切换前置（docs/plan/implementation/03_DATABASE_MIGRATION.md:445-477）。

