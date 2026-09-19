# Legacy care materializer — IMPLEMENTED_NOT_REVIEWED

本轮只实现 identity-v1 私有档案到正式业务表的第一步：
`FormulaProduct`、`FeedingRecord`、`SleepRecord`、`DiaperRecord`。脚本不连接数据库，由受控迁移身份将渲染出的单一事务 SQL 送入独立 PostgreSQL。

## 接口和边界

- `scripts/legacy-import/materialize_care.py`
  - `prepare_records(data, checksum)` 做完整预校验和 typed mapping。
  - `prepare_formula_products(data, checksum)` 复用 `formula_mapper.py` 的严格字段/精度校验；原始 `nutrientsJson` 作为 SQL 文本直接 `::jsonb`，不再 JSON 双重编码。
  - `render_materialization(data, checksum)` 返回单一事务 SQL；要求对应的 `legacy_import.import_batches` 已由 identity-v1 导入。
  - `--archive/--sha256/--output` 只写私有、不可覆盖的输出文件；CLI 只打印类型和数量，不打印源正文。
- 目标 ID 保留旧记录 `id`；`recordedById` 只有在 archive User、目标 FamilyMember、目标 BabyMember 都有效时才写入 `recorded_by_user_id`。
- 时间按 archive 的 `Asia/Shanghai` 明确解释无时区旧值，再规范化为 UTC；`clientId` 写入 `legacy_client_id`。旧原始时间、类型、scope、actor、额外字段和源快照标识进入受控 `legacy_metadata`，完整正文仍只在 `legacy_import.import_rows`。
- `sourceKey=<archiveSha256>/<sourceTable>/<sourceId>`；`source_hash` 使用 canonical sorted JSON SHA-256；`mapping_version=care-v1`。receipt 还保存目标 snapshot 与 hash，重复执行会逐字段核对记录、timeline、receipt，发现目标被改动即失败。
- FormulaProduct 使用 `mapping_version=formula-v1`，同一 source batch 的 receipt 逐字段核对产品、原始 nutrients JSON 和家庭；产品 SQL 总在 feeding SQL 前执行。每次重放先重新核验 raw-row `payload_hash`，再允许 receipt no-op，避免只改档案正文却被旧 receipt 掩盖。
- Feeding 的 `formulaProductId` 必须已经在同一 Family 的正式 `formula_products` 中；缺失或跨家庭会回滚。`solid` 等不属于这三个 canonical 表的旧类型会 fail closed，不能静默改成别的记录。

## Schema

`prisma/migrations/202609190018_legacy_care_promotion/migration.sql` 增加：

- `legacy_idempotency_mappings` 的 source system/batch/table/id/hash、mapping version、metadata 字段；
- 三个 care 表的 `legacy_client_id`、`legacy_metadata` 和按 baby 的非空 clientId 唯一索引。

`prisma/schema.prisma` 已同步上述字段。该 migration 是 additive；没有改动 `ios_backup.py` 或 `test_ios_backup.py`。

## 验证

- `python3 scripts/legacy-import/test_care_materializer.py`：通过。覆盖 FormulaProduct 映射、空 brand、原始 nutrients JSON、类型/日期/actor/clientId/metadata 映射、cross-family 预拒绝、同 baby 重复 clientId、事务 SQL 不变量。
- `python3 scripts/legacy-import/test_formula_mapper.py`：通过；保留已有 mapper 的四项精度/字段拒绝测试。
- `python3 -m py_compile scripts/legacy-import/materialize_care.py scripts/legacy-import/test_care_materializer.py scripts/legacy-import/test_care_materializer_integration.py`：通过。
- `npx prisma validate --schema prisma/schema.prisma`：通过。
- 主 runner 的 round16 owned 结果已通过：`/tmp/growdesk-owned-care-round16.log` 第 78 行记录 `Care materializer owned PG PASS`，并完成主集成套件。该结果对应本文件此前版本。
- 本轮新增 `scripts/legacy-import/test_care_materializer.py` 的临时 SQLite 回归：由 `snapshot.capture` 导出临时数据库，再将生成的 `legacy.json` 送入 `prepare_records`/`render_materialization`；验证 SQLite `BOOLEAN` 的整数 `0` 变为 canonical `false`。当前纯测试通过；由于随后加入了 SQLite 布尔兼容修复，owned `--legacy-care` 需要重新执行后才能更新为当前版本证据。
- SQLite care 字段形态按旧 Prisma/migration 与临时导出核对：`spitUp` 是 SQLite INTEGER `0/1`；`nightWakingCount`、`leftMinutes`、`rightMinutes`、`durationMinutes` 是 INTEGER 或 NULL；amount 是 INTEGER/REAL 或 NULL；时间、type、notes、poop 字段是 TEXT 或 NULL。materializer 对整数计数保持严格非负整数校验，只有 `spitUp` 允许 JSON bool 或精确整数 `0/1`。
- `scripts/test-integration.py --legacy-care` 已接入为显式 opt-in；默认总 runner 不执行该测试。

## 待独立 review / 下一步

- 这是实现者证据，状态仍为 `IMPLEMENTED_NOT_REVIEWED`；尚未声明生产迁移或上线。
- round16 结果仅是此前版本的实现者证据，状态仍为 `IMPLEMENTED_NOT_REVIEWED`；本轮布尔修复必须由主 runner 复测后，才可作为当前版本证据，仍不声明 accepted 或生产 ready。
- 真实 archive 中不属于本 slice 的记录类型、附件、FoodPlan、Supplement、Vaccine 等仍需各自 typed mapper、quarantine 和对账；本文件不把 raw archive 存在宣称为业务导入完成。

## Round 17b current implementation check

Root independently ran both pure scripts successfully, including the temporary SQLite snapshot round trip and all four formula mapper tests. `/tmp/growdesk-owned-s3-ui-round17b.log` line 78 records the current care importer owned PostgreSQL checks passing with SQLite integer booleans. The same run passed 203 backend main tests. The browser lane is separate and was still running when this importer checkpoint was recorded. This is not a production import or a claim that the other archived business tables have been materialized.
