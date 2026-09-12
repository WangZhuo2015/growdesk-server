# 任务执行报告：SH-02A 数据模型与迁移

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`2226345d3eb97c1d76378c2cfb4715f5a8984950` (SH-01)  
> 依赖前置：`SH-01` (已完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 7 节（SH-02）、第 70 行拆分规则及 `02_BACKEND_CONTRACTS.md`、`03_DATABASE_MIGRATION.md` 规范，实施 **SH-02A 数据模型与迁移**：
1. **已部署身份基线保留**：完整审查并保留 `202609120001_identity` 迁移（User, Family, FamilyMember, Baby, BabyMember, UserSyncState, FamilySyncState, legacy_import），不改写历史 SQL，不破坏现有数据库状态。
2. **正式数据模型扩充（新迁移 `202609120002_foundation`）**：
   - 会话与凭据：`device_sessions`、`refresh_credentials`、`recovery_codes`、`legacy_invite_code_mappings`
   - 幂等与离线兼容：`idempotency_receipts` (复合主键 actor_id, scope_id, command_id)、`legacy_idempotency_mappings`
   - 增量同步与变更 Feed：`family_changes` (复合主键 family_id, cursor)、`user_changes` (复合主键 user_id, cursor)、`sync_snapshots`
   - 任务底座与调度：`task_executions`、`task_outbox`
   - 时间线与首个照护业务模型：`timeline_entries`、`feeding_records` (严格复合外键 `[family_id, baby_id] REFERENCES babies(family_id, id)`，数值采用 `DECIMAL(10,3)` 确保存储精度)
3. **数据库工程管道与命令接管**：
   - 实现 `scripts/db-generate.mjs`：安全包装 `prisma generate`，输出至 `packages/database/src/generated/`，并已加入 `.gitignore` 与 `check-architecture.mjs` 白名单。
   - 实现 `scripts/db-validate.mjs`：离线验证 schema 语法并核对 migration 目录完整性与各迁移 SQL 非空。
   - 实现 `scripts/db-migrate.mjs`：生产/测试受控迁移部署入口。
   - `package.json` 正式替换原 `scripts/not-ready.mjs` 占位为真实命令。
   - `prisma.config.ts` 增加安全的本地 loopback fallback，使 CI/构建管道在无需外部 DB 时仍能完成 schema 校验与 client 生成。
4. **真实 PG18 数据库集成测试与硬边界验证**：
   - 编写 `tests/integration/foundation-migration.test.ts`，在独立托管的 PostgreSQL 18.6 实例中全量跑通：
     - 迁移顺序升级测试（从空库及 0001 身份基线均可顺利升级）
     - 复合外键强约束测试（跨家庭非法引用 babyId 触发 23503 异常）
     - CHECK 约束测试（非法 platform、feeding_type、task status 或 <=0 的 version 均触发 23514 异常）
     - 账号删除级联隔离测试（删除 User 级联删除 session、refresh_credentials、recovery_codes 与 baby_members，但**严格保留**共享的 Baby 与照护 FeedingRecord）
     - 幂等 Receipt 主键唯一性（重复插入同 actor+scope+command 触发 23505）
     - 索引查询计划测试（验证 `ix_feeding_records_baby_timeline` 索引正常生成并可被 EXPLAIN 使用）

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 增加 DeviceSession, RefreshCredential, RecoveryCode, LegacyInviteCodeMapping, IdempotencyReceipt, LegacyIdempotencyMapping, FamilyChange, UserChange, SyncSnapshot, TaskExecution, TaskOutbox, TimelineEntry, FeedingRecord 及其反向关系 |
| `prisma/migrations/202609120002_foundation/migration.sql` | 新增 | 第二个正式 PG18 DDL 迁移文件，含建表、索引、复合外键、CHECK 约束与 REVOKE ALL FROM PUBLIC |
| `prisma.config.ts` | 修改 | 配置安全 loopback fallback，支持离线 generate 与 validate |
| `scripts/db-generate.mjs` | 新增 | Prisma client 代码生成命令封装 |
| `scripts/db-validate.mjs` | 新增 | Prisma schema 与 migration 目录完整性校验 |
| `scripts/db-migrate.mjs` | 新增 | 数据库迁移部署命令封装 |
| `scripts/check-architecture.mjs` | 修改 | 忽略 machine-generated 代码目录 `packages/database/src/generated` |
| `scripts/test-integration.py` | 修改 | 集成测试运行器按序执行 legacy-import 与 foundation-migration 测试套件 |
| `tests/integration/foundation-migration.test.ts` | 新增 | 针对真实 PG18 实例的完整迁移与数据库约束集成测试套件 |
| `package.json` | 修改 | 替换 backend:db:generate, backend:db:validate, backend:db:migrate 占位 |
| `.gitignore` | 修改 | 忽略 `packages/database/src/generated/` |
| `evidence/tasks/SH-02A/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 数据库代码生成与校验
```bash
npm run backend:db:generate
# Output:
# Loaded Prisma config from prisma.config.ts.
# Prisma schema loaded from prisma/schema.prisma.
# ✔ Generated Prisma Client (7.10.0) to ./packages/database/src/generated in 120ms
# Database client generation complete.

npm run backend:db:validate
# Output:
# Validating Prisma schema...
# Loaded Prisma config from prisma.config.ts.
# Prisma schema loaded from prisma/schema.prisma.
# The schema at prisma/schema.prisma is valid 🚀
# Verifying migration directory integrity...
# Database validation passed: 2 migrations verified.
```

### 3.2 架构分层与无 any 检查
```bash
npm run backend:lint
# Output:
# Architecture check passed (46 TypeScript source files).

npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)
```

### 3.3 单元测试套件
```bash
npm run backend:test:unit
# Output:
# ℹ tests 81
# ℹ suites 1
# ℹ pass 81
# ℹ fail 0
# ℹ duration_ms 1517.374375
```

### 3.4 真实 PostgreSQL 18 集成测试套件
```bash
python3 scripts/test-integration.py
# Output:
# Legacy import integration PASS: atomic rollback, same batch retry, changed batch refusal, multi-family composite FK, user deletion preserves shared baby, archive private.
# ✔ SH-02A: foundation migration applies cleanly and establishes all core tables (55.770792ms)
# ✔ SH-02A: composite foreign keys prevent cross-family baby reference (14.221333ms)
# ✔ SH-02A: check constraints reject invalid values and enforce version/cursor non-negative (9.631958ms)
# ✔ SH-02A: user deletion cascades credentials/sessions but preserves shared baby (14.723958ms)
# ✔ SH-02A: idempotency receipt primary key enforces actor/scope/command uniqueness (7.874667ms)
# ✔ SH-02A: index query plan confirms timeline index usage (7.825542ms)
# ✔ isolated PostgreSQL enforces role, ownership, constraints and rollback (20.208167ms)
# ✔ isolated authenticated Redis has working expiry and atomic NX writes (5.819792ms)
# ✔ foundation HTTP readiness checks owned PostgreSQL and Redis with real drivers (302.341792ms)
# ℹ tests 9
# ℹ suites 0
# ℹ pass 9
# ℹ fail 0
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
# Owned test processes stopped and private data directory removed.
```

### 3.5 证据格式自检
```bash
npm run backend:evidence:check -- --task SH-02A
# Output:
# Evidence shape check passed for SH-02A (1 files).
```

---

## 4. 下一步工作（SH-02B 前置）

SH-02A（数据模型与迁移底座）已完全就绪。下一步将直接推进 **SH-02B: UnitOfWork 和统一事务基础 (UnitOfWork & Idempotent Transaction Base)**：
1. 实现严格的全局加锁顺序：`UserSyncState(userId asc) -> FamilySyncState(familyId asc) -> DeviceSession -> RefreshCredential -> TaskExecution -> 业务实体`。
2. 事务内取得锁后重验权限；
3. 原子事务内协同推进：业务实体写 + 版本乐观锁 + TimelineEntry 维护 + FamilySyncState cursor 行锁推进 + FamilyChange 记录 + IdempotencyReceipt 落地 + TaskOutbox 事件派发；
4. 验证并发唯一性、重放攻击检测（相同 hash 返回已存结果，不同 hash 返回 409 IDEMPOTENCY_KEY_REUSED）、事务中途失败原子回滚。
