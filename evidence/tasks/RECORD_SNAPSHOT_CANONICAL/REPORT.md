# GrowDesk RecordSnapshot canonicalization — 2026-09-19

状态：**IMPLEMENTED_NOT_REVIEWED**。本卡未提交、未部署、未执行生产迁移，也未读取生产数据。

## 本卡文件

- `prisma/migrations/202609190023_record_snapshots/migration.sql`
- `prisma/schema.prisma`（RecordSnapshot 模型及 User/Family/Baby 关系；文件另有并行 voice 改动）
- `packages/contracts/src/records.ts`
- `packages/contracts/src/routes.ts`
- `apps/api/src/services/record-snapshot-service.ts`
- `apps/api/src/routes/record-snapshot-routes.ts`
- `apps/api/src/app.ts`（schema 与 route 注册；文件另有并行改动）
- `lib/mcp/server.ts`（GrowDesk 分支）
- `scripts/legacy-import/materialize_record_snapshots.py`
- `scripts/legacy-import/test_record_snapshot_materializer.py`
- `scripts/legacy-import/test_record_snapshot_materializer_integration.py`
- `scripts/test-integration.py`（隔离 runner wiring）

## 已实现

- PostgreSQL 持久化快照包含 family/baby/user scope、payload/source hash、来源批次/表/ID、restored 状态及审计时间；迁移编号为 `202609190023_record_snapshots`，保留并行 voice 的 `202609190022_agent_voice_logs`。
- 删除在同一事务中校验 active FamilyMember/BabyMember、锁家庭 cursor 与目标记录、写 snapshot、软删除并写 timeline/change；支持幂等 receipt 与 baseVersion 冲突保护。
- restore 在同一事务中校验 snapshot scope、payload hash、目标行未被其他写入修改，然后恢复并标记 snapshot；重复 restore 返回 replayed；跨家庭不可读取或恢复。
- feeding/sleep/diaper/food/growth/medical_report/vaccine/supplement 使用原行 tombstone 恢复。`BabyFoodPlan` 没有 tombstone，已采用锁宝宝行后的物理删除 + 精确 planData/version/timestamp 重建；已有新 plan 时返回冲突。
- Web GrowDesk MCP 的 delete/restore 与批量健康档案分支已移除进程内 `bffSnapshots`，改为调用持久化后端；工具外部返回字段保持原契约。MCP 传递可选 `clientId` 幂等键，并在按日期选择时传递记录版本。
- 旧 `RecordSnapshot` ETL 验证完整来源 hash、payload hash、scope，写入 target receipt；重放保留目标后续修改，receipt/target/source tamper 与 ID rollback 冲突全部回滚失败。

## 已执行验证

- `python3 scripts/legacy-import/test_record_snapshot_materializer.py` — 5/5 纯物化器检查通过。
- `npm run backend:typecheck`、`npx prisma validate --schema prisma/schema.prisma` — 通过。
- `npm run backend:contracts:generate`、`npm run backend:contracts:check` — 通过（104 paths、150 operations、56 schema components）。
- Web `npm run typecheck`、`npx oxlint lib/mcp/server.ts` — 通过；oxlint 仅报告既有 warning。
- `python3 scripts/test-integration.py --record-snapshot-only` — 通过：owned infrastructure 3/3、RecordSnapshot API 6/6、materializer owned PostgreSQL integration PASS。该 runner 只使用 `test_`/`e2e_` 数据并在结束时清理。
- `git diff --check`（本卡 server/Web 文件）— 通过。

## 差距与阻断

- 本卡 focused runner 已覆盖删除、无 body、跨家庭 scope、payload tamper、幂等 restore、food_plan 精确物理恢复；完整全仓 runner 仍需父任务在并行 voice/其他卡合并后复跑，不能由本卡单独宣称全仓验收。
- 尚未执行真实部署后的进程重启验证或生产迁移；本报告不宣称已上线或生产可用。
- `food_plan` 只支持 canonical `BabyFoodPlan` 精确行 payload；无法证明旧 SQLite 中非 canonical 的历史计划结构时，ETL 会拒绝该行，不能伪造字段。
