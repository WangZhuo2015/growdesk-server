# Legacy business ETL map — IMPLEMENTED_NOT_REVIEWED

审计范围：只读检查当前仓库、版本化 schema/迁移、identity-v1 archive importer、
`source-inventory.json` 和已存在的 care promotion。没有读取生产数据库、旧生产 SQLite、
3088 服务或 secrets，也没有运行共享 PG/build runner。

源事实固定为 `evidence/tasks/LEGACY_IMPORT/source-inventory.json:2-5,6-59`：
`sourceSha256=92a152f...9edfe`、`archiveSha256=295d648...87bd2`、
`capturedAt=2026-09-12T07:59:14.194209+00:00`。表内数量来自这份已冻结的 archive，
不是从当前目标库推测出来的。

## 当前导入边界

`scripts/legacy-import/import_sql.py:37-57` 只做 archive 格式、身份关系、生日、成员角色和
密码 hash 前缀校验；`render_import` 在 `scripts/legacy-import/import_sql.py:60-89` 将所有表
写入 `legacy_import.import_rows`，正式表只写 User、Family、Baby、FamilyMember 和派生
BabyMember。`deploy/import-legacy-target.py:46-55` 也只执行 identity import 和 target verify，
没有业务 promotion 阶段。因此 raw archive 存在不能作为业务历史已迁移的证据。

当前唯一的业务例外是 care slice：
`scripts/legacy-import/materialize_care.py:8-11,950-991` 已渲染 FormulaProduct、
FeedingRecord、SleepRecord、DiaperRecord 的单事务 SQL；其字段和 receipt 边界见
`evidence/tasks/LEGACY_IMPORT/CARE_MATERIALIZER.md:1-26`。本轮 SQLite `spitUp=0/1`
兼容修复后的纯回归已通过；round16 日志对应修复前版本。随后协调消息报告 round17b
已经以当前 bool 适配完成 owned PG、主集成和 S3 检查，但该轮私有 runner 输出尚未落入
本报告目录；因此 slice 仍标为 `IMPLEMENTED_NOT_REVIEWED`，不能把协调消息当作本报告的
独立 accepted/production 证据（当前证据边界仍见 `CARE_MATERIALIZER.md:28-43`）。

## 逐表映射、依赖和阻塞

| 源表（数量） | 目标/现有路径 | 可复用的 promotion 约束与字段映射 | 状态、依赖和下一步 |
|---|---|---|---|
| `User` 5、`Family` 1、`Baby` 1、`FamilyMember` 5 | `public.users/families/babies/family_members`；`import_sql.py:76-89` | identity-v1 已保留源 ID、家庭关系、成员角色；Baby 孕周 weeks→days 修复只影响未来生成 SQL，既有批次仍需逐行核对 | **已有 identity baseline**；不等于业务历史可读。保留空身份库拒绝和 raw batch replay guard。 |
| `FormulaProduct` 2 | `FormulaProduct`（`prisma/schema.prisma:479-503`） | 当前 care promotion 使用 `formula_mapper.py` 的 brand/name/stage/Decimal/nutrients 原文 JSON，并在 Feeding 前插入；复用 source hash、目标 snapshot、family FK receipt | **已有 materializer，IMPLEMENTED_NOT_REVIEWED**；round17b 已被协调报告为当前版本 owned PASS，仍待把私有输出纳入正式证据。 |
| `FeedingRecord` 84、`SleepRecord` 48、`DiaperRecord` 48 | `feeding_records/sleep_records/diaper_records`；目标 schema 分别见 `prisma/schema.prisma:447-477,506-558` | 当前 mapper 已复用 baby→family、actor/member、Asia/Shanghai→UTC、clientId/metadata、重复 clientId、cross-family 和单事务回滚；SQLite `spitUp` 只接受 bool 或精确 0/1 | **已有 materializer，round17b 当前 bool 适配已被协调报告为 owned PASS**；仍保持 IMPLEMENTED_NOT_REVIEWED，其他 care 类型继续 fail closed。 |
| `GrowthMeasurement` 7 | `GrowthMeasurement`（`prisma/schema.prisma:654-675`），运行时 `apps/api/src/services/growth-service.ts:47-129,145-199` | 可直接复用 care 的 identity context、稳定旧 ID、source hash/receipt、timeline SQL；`date`→`measurementDate @db.Date`，三项测量值保持 Decimal，`notes`/`attachmentId` 需单独处理 | **最适合下一小提交**。源 `ageInMonths/ageLabel/percentile` 在目标表没有专列，必须进入受控 metadata/notes 或 quarantine；`imageUrl` 依赖 Attachment promotion，不能复制成未授权 URL。 |
| `MedicalReport` 2 | `MedicalReport` + `MedicalReportAttachment`（`prisma/schema.prisma:705-745`），运行时 `apps/api/src/services/medical-service.ts:62-126,129-225` | 可复用 identity/actor、稳定 ID、source hash/receipt 和 atomic timeline；旧 `category→department`、`doctorNotes→diagnosis`、`aiSummary→notes`，`itemsJson` 必须解析为 JSONB 并保留原始序列化证明 | **可复用 promotion scaffold，但排在 Growth 后**。`imageUrl` 必须先有 Attachment 的 hash/size/objectKey/ACL/status 映射；caregiver 只能是归档中有效家庭成员，不能用当前登录用户冒充。 |
| 附件 29 个、75,592,030 bytes | 目标 `Attachment`（`prisma/schema.prisma:677-703`）及医疗 join 表 | `snapshot.py` 只复制私有 archive 文件；目标还要求 uploader、purpose、mime、byteSize、sha256、objectKey、status 和 family/baby 归属 | **独立阻塞项**。尚无 archive-file→Attachment/object-storage promotion、引用扫描和 hash/size 对账；Growth/Medical 的图片行不能被宣称已迁移。 |
| `FoodItem` 50、`FoodLogRecord` 14、`FamilyFoodStatus` 6 | `FoodLibraryItem`/`FamilyFoodStatus`/`FoodRecord`（`prisma/schema.prisma:560-614`），运行时 `apps/api/src/services/food-service.ts:157-385` | FoodLog 的 foods JSON 需映射为稳定 food IDs；portion/acceptance/babyState/abnormal 没有一一对应目标列，必须保留到明确的 metadata/notes 或扩展 schema。旧 status 的 `firstAddedDate/acceptance` 也不能悄悄丢弃 | **未有 archive ETL**。公共 food reference seed 与家庭 FoodLog/status 是两条不同路径；先固定字段保留策略，再做 ID/FK/count 对账。 |
| `FoodPlan` 0 | 新 `BabyFoodPlan`（`prisma/schema.prisma:616-630`） | archive 明确为零行，不应从新 plan CAS 或 BFF 状态反推旧 plan | **明确 zero-source**；不需要导入，但验收报告必须保留 0 的证据。 |
| `SupplementProduct` 3、`SupplementSchedule` 3 | 当前正式 schema 没有对应 model；只有 `SupplementRecord`（`prisma/schema.prisma:632-652`） | 旧产品含 dosageForm/unit/defaultDose/nutrients，计划含 frequency/customDays/targetDose/reminder；这些不能塞进只含名称、时间、amount 的记录而声称等价 | **schema/contract blocker**。需要先决定正式 product/schedule 模型，或明确历史只读承载；现有 BFF `planData.supplementState` 不能替代旧三张表的逐行 lineage。 |
| `SupplementRecord` 24 | `SupplementRecord`（`prisma/schema.prisma:632-652`），运行时 `apps/api/src/services/supplement-service.ts:45-119,139-228` | 可复用 promotion 的 scope/actor/source hash/receipt；旧 `productId+date+time+dose+unitName` 需解析成 `supplementName+occurredAt+amount`，产品表缺失时必须 quarantine 或保留原 product ID | **不能独立宣称完成**；依赖 SupplementProduct 的承载决策和 date/time 本地时区规则。 |
| `Vaccine` 33、`VaccineDose` 58、`VaccineSourceRef` 0、`VaccineStrategyGroup` 3、`VaccineScheduleEntry` 51 | 当前只有 `VaccineSchedule`（`prisma/schema.prisma:748-760`）和 `VaccineRecord`；服务的 default fallback 在 `apps/api/src/services/vaccine-service.ts:11-126` | 旧 reference 需保留 catch-up、target population、policy、产品、地区说明、dose 最大间隔和 source refs；静态 fallback 不能充当 33/58/51/3 行的导入 | **reference schema blocker**。必须先确定旧 reference 的正式承载与版本/hash 验收；不能用少量 default schedule 覆盖缺失内容。 |
| `VaccineRecord` 5 | `VaccineRecord`（`prisma/schema.prisma:762-784`） | 旧记录是 name/dose/scheduledDate/completedDate/isCompleted；目标要求稳定 vaccineCode/administeredDate/caregiver，日期不能伪造时区 instant | **依赖 Vaccine reference 映射**；没有稳定 code 或 completed/scheduled 语义决策前只能 quarantine，不能写错码。 |
| `VaccineSelection` 4 | 目标 schema 当前没有 selection model/route/repository | 需要 `(babyId,vaccineId,doseNumber)` 唯一键、selected/completed、version、FK 和 receipt；raw archive 不能作为 Web 查询 | **明确无实现**，先补正式模型/迁移再做 ETL。 |
| `DevelopmentMilestone` 119、`DevelopmentWarningSign` 32、`FeedingGuideline` 4、`ActivityRecommendation` 25 | server 已有版本化静态投影 `apps/api/src/knowledge/legacy-reference-data.ts:1-4`，路由在 `apps/api/src/routes/knowledge-routes.ts:9-27`；契约保留 `details`/dataRelease（`packages/contracts/src/knowledge.ts:3-69`） | 这些不是家庭业务记录，不应写入 family feed；应以 release/source hash 验收，milestone 按 assessment month 排序并保留 details/source refs | **已有静态实现，但不是 archive promotion**。下一步是与旧数据 release 对账，不要重复 materialize 到家庭表。 |
| `SourceRef` 59、`DataRelease` 1、`MilestoneSourceRef` 0 | knowledge static release currently embedded in `legacy-reference-data.ts` | source ID、release metadata 必须作为静态版本证据；不能从 raw archive 生成随机业务 ID | **静态内容对账项**；缺少当前 archive→release hash 报告，但不阻塞 care/growth 记录 promotion。 |
| `FoodItem` 的知识字段、`Book` 5、`FamilyBookStatus` 0 | Food public reference 由当前 server migration/helper 另行维护；Book route/静态资料不属于家庭业务 ETL | 旧 FoodItem 的营养、做法、过敏、噎食、texture 等字段远多于 `FoodLibraryItem` 最小运行列；Book status 源为 0 | **需区分 public reference 与 family state**。Food metadata 要走版本化 reference 对账；Book family history 本次为零行。 |
| `ScheduleEngineRule` 8 | 当前 server 没有等价的 archive promotion target；vaccine service 只提供 runtime schedule | 保留 ruleId、vaccine IDs、source refs 和版本，不把规则压成 VaccineRecord | **静态/reference 缺口**；随 Vaccine reference 方案处理。 |
| `AiArchive` 502、`AiChatSession` 17、`AiChatMessage` 62、`AiJob` 4、`AgentVoiceLog` 9、`RecordSnapshot` 7 | server 有部分 `AiSession/AiChatMessage/AiRun` runtime model，但无 legacy archive materializer；`AiArchive` 还与附件对象关联 | 私人文本、文件、任务状态和快照需要独立 author/scope/retention/attachment 规则；不能用照护记录 mapper 猜测 | **独立高风险 slice**；raw archive 保留，先定隐私/任务/附件契约再排期。 |
| excluded `OAuth*` 120、`PersonalAccessToken` 1、`PushSubscription` 3 | 不进入业务 migration | `import_sql.py` archive manifest 明确排除；不得把 token/credential 放入业务 DTO、receipt 或日志 | **按安全边界保留 excluded**；不应为“完整”而导入。 |

## 下一小提交建议

**Growth 优先，Medical 第二。** Growth 只有 7 行，目标正式表、repository/service、date/Decimal
字段和 timeline 都已存在，能够直接复用当前 care promotion 的 identity context、稳定源 ID、
metadata、source hash、目标 snapshot/hash 和单事务 receipt。第一步应只实现无图片行的 typed
mapper，并把 `ageInMonths/ageLabel/percentile` 明确写入受控 metadata 或 quarantine；图片行必须
等待 Attachment mapping，不可将旧 URL 当作目标 `attachmentId`。

Medical 也能复用同一 promotion scaffold，但应等 Attachment 方案确定后做：目标 service 已经
要求 family/baby/purpose/status-ready 的 attachment 归属（`medical-service.ts:191-205`），而旧
`imageUrl` 只有路径语义。医疗两行的 `itemsJson`、category/doctorNotes/aiSummary 映射可以先
用纯 mapper 验证，但没有附件 hash/size/ACL 对账就不能把整行标为 ready。

这张表只说明代码和数据依赖，不能替代隔离 PG 的 count、ID 集合、FK/actor、timeline、receipt、
attachment hash 及重复执行验收。计划 09 要求 typed mapper、promotion receipt 且禁止把
`legacy_import` 作为在线查询来源（`docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md:246-260`）；
计划 03 的日期、numeric、JSON、附件和验收边界见 `docs/plan/implementation/03_DATABASE_MIGRATION.md:84-104,228-275,350-375`。
