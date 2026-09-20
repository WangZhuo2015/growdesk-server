# Legacy Supplement/Vaccine Promotion

任务：将冻结 identity-v1 archive 中的 SupplementProduct、SupplementSchedule、SupplementRecord、Vaccine、VaccineDose、VaccineScheduleEntry、VaccineStrategyGroup、VaccineSelection、VaccineRecord 以类型化方式 promotion 到 PostgreSQL canonical tables。

状态：IMPLEMENTED_NOT_REVIEWED

基线 HEAD / 完成定位：基线为当前工作树 `619f1cb`；本报告对应工作树 diff，未提交。

## 结论

当前 canonical schema 原本只有简化的 `supplement_records`、`vaccine_schedules` 和 `vaccine_records`，不能承载旧产品/计划、完整疫苗 reference graph、选择状态或旧疫苗预约/完成字段。本切片新增了 additive migration `202609190021_supplement_vaccine_promotion`：

- `supplement_products`、`supplement_schedules`；扩展 `supplement_records` 保留 product、dose、unit、source、client 和 actor。
- `vaccines`、`vaccine_doses`、`vaccine_schedule_entries`、`vaccine_strategy_groups`、`vaccine_selections`；扩展 `vaccine_records` 保留 source vaccine、legacy name/dose、scheduled/completed/isCompleted。
- 所有 family/baby 记录使用 family FK 或 `(family_id,baby_id)` 复合 FK；记录 actor 只接受同家庭 active member，缺失 actor 时固定选择字典序最小的 active admin，并在 metadata 中保留完整 source row。

每个 target row 都保留原 source ID，receipt 在 `legacy_idempotency_mappings` 写入 `sourceHashSha256`、`targetSnapshot`、`targetHashSha256`、mapping version、family/baby scope 和 source lineage。记录类同时原子写入 `timeline_entries`。重复执行必须同时满足 source hash、receipt metadata、target snapshot 和 timeline snapshot；任一项被篡改都会失败并回滚。

## 允许范围 / 实际改动文件

- `prisma/schema.prisma`
- `prisma/migrations/202609190021_supplement_vaccine_promotion/migration.sql`
- `scripts/legacy-import/materialize_supplement_vaccine.py`
- `scripts/legacy-import/test_supplement_vaccine_materializer.py`
- `scripts/legacy-import/test_supplement_vaccine_materializer_integration.py`
- 本报告

没有修改 deploy、附件、食物、医疗文件或共享 integration runner；没有连接生产、旧 SQLite、生产 PostgreSQL 或读取 secrets。集成 fixture 账号、家庭、宝宝和记录 ID 全部使用 `test_` 前缀。

## 旧快照覆盖范围

脱敏 source inventory 记录的待 promotion 行数为：SupplementProduct 3、SupplementSchedule 3、SupplementRecord 24、Vaccine 33、VaccineDose 58、VaccineScheduleEntry 51、VaccineStrategyGroup 3、VaccineSelection 4、VaccineRecord 5、VaccineSourceRef 0、ScheduleEngineRule 8。本 materializer 对本切片拥有的表做 count guard；SourceRef/VaccineSourceRef 连接和 ScheduleEngineRule 仍由独立 reference slice 负责，当前若出现非零行会 fail closed，不会静默丢弃。真实快照尚未在本任务中读取或执行。

## 验证命令与结果

1. `python3 -m unittest scripts/legacy-import/test_supplement_vaccine_materializer.py -v` — PASS，6 tests。
   - full graph mapping、跨 family baby、跨家庭 actor、未解析 vaccine reference、有限 numeric/JSON、name fallback、旧 required 字段、numeric(12,5) 越界、确定性 SQL、source hash guard，以及 unsupported SourceRef/rule fail-closed。
2. `npx prisma validate --schema prisma/schema.prisma` — PASS。
3. owned PostgreSQL 18 runner（临时目录、专用 `test_runner`、随机数据库密码）应用全量 migration 后执行 `scripts/legacy-import/test_supplement_vaccine_materializer_integration.py` — PASS。
   - 9 类 source table 全 graph promotion；9 receipts；2 timeline projections；target/source hash 对账。
   - 同批精确 replay 为 no-op。
   - 修改 target notes 后 replay 被拒绝。
   - 第二个 source row 的 `payload_hash` 被篡改时，整批 2-row promotion 失败，前一行没有残留 target 或 receipt。
   - 临时 PostgreSQL、Redis 和测试数据由 owned runner 清理。

验证期间没有使用真实生产数据；本地 runner 的 Fastify warning 属于已有未补齐 route schema 警告，与本切片 SQL 测试无关。

## 未解决项 / 切换影响

- 本切片仍是 promotion 实现，未执行真实冻结 archive；真实执行必须在独立 PG 副本上先核对 source inventory、每表 ID 集合、FK、hash 和 quarantine，再进入最终停写/切换门禁。
- `VaccineRecord` 旧模型没有稳定 vaccine foreign key 时只在唯一名称匹配时绑定 `vaccines`；重复名称会 fail closed，不生成猜测关系。
- scheduled-only 的旧 `VaccineRecord` 现在保留 `scheduled_date`，并明确写入 `completed_date=NULL,is_completed=false`；没有伪造完成日期。但现有 canonical `administered_date` 仍是历史必填列，只能暂存该预约日作为排序/时间轴日期。当前 `VaccineService` 只读/返回 `administeredDate`，旧 Web 的 `fromGrowDeskVaccineRecord` 又会把它投影成 `completedDate` 且 `isCompleted=true`，所以这类行在 API/BFF 接线完成前不能切换流量；需要可表达 pending 的 API/nullable actual-date 方案。
- 当前 API 的 `VaccineService` 仍读取旧的 `vaccine_schedules` 简化表并在空表时使用内置默认日程；本切片新增的 `vaccines`、`vaccine_doses`、`vaccine_schedule_entries`、`vaccine_strategy_groups`、`vaccine_selections` 需要在后续 Web/API 适配任务中接入读路径。导入数据已完整落到 canonical 表，但这项运行时接线不应被本报告视为已完成。
- `SupplementService` 已能读取扩展后的 `supplement_records`；产品目录、补充剂计划和选择状态的专门 API 读写接线仍需由后续 parity 任务覆盖。
- **切换阻断：当前 GrowDesk Web BFF 仍从 `BabyFoodPlan.planData` 读取旧线协议。** 营养产品/计划读取 `planData.supplementState.supplementProducts/supplementSchedules`，疫苗 selection 读取/写入 `planData.vaccineSelections`，未完成疫苗读取/写入 `planData.legacyPendingVaccines`。本 materializer 只写 normalized tables，不写兼容 `planData` projection；因此迁移后旧 BFF 会看到空的补剂产品/计划、selection 和 pending，而 normalized rows 虽存在却在线不可见。切换前必须二选一：在同一事务内按 baby 锁定 food plan、CAS 合并并审计/hash 记录兼容 projection（保留 planData 其它字段），或先让 BFF/API 改读 normalized endpoints 并覆盖读写/并发语义。不能用只落新表作为“无缝迁移”验收。
- 上述 projection 还不能单独解决 scheduled-only vaccine：现有 BFF canonical-record adapter 会误显完成，必须同时接入 pending/状态字段，并为 projection 做 source-to-target receipt、replay/tamper 校验，避免 normalized 表与 planData 半成功。
- SourceRef/DataRelease 连接表及附件不在本任务范围内，不能用本报告宣称整个 vaccine/medical reference migration 完成。
- 运行服务需在包含该 additive migration 的镜像上重新生成 Prisma client；本任务没有部署或修改生产服务。

## 交给 reviewer 最应检查的 3 处

1. `materialize_supplement_vaccine.py` 的 `_baby_context`/`_family_context` 和 vaccine name fallback 是否仍满足显式 family/baby/member scope。
2. `_render_item` 的 receipt、target snapshot、timeline replay predicate 及 source payload hash guard 是否覆盖所有 target columns。
3. `202609190021_supplement_vaccine_promotion/migration.sql` 与 Prisma model 的列、FK、unique/index 是否能在空库和已有 0001–0020 migration 后一致升级。
