# 任务执行报告：SH-04SU 补剂记录链路 (Supplement Record Pipeline)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`cd87d32` (SH-04FO)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A`、`SH-03C`、`SH-04F`、`SH-04D`、`SH-04S`、`SH-04FO` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节（SH-04 任务卡）及 `02_BACKEND_CONTRACTS.md` 规范，实施 **SH-04SU 补剂记录链路**：

1. **数据库迁移与模型 (`202609120007_care_supplement`)**：
   - `supplement_records` 表：记录宝宝维生素/矿物质/滴剂等补剂日志，包含 `supplement_name`、`occurred_at`、`amount`、`notes`、`version`、`deleted_at`、`created_at`、`updated_at`；
   - 建立复合外键约束 `fk_supplement_records_family_id_baby_id_fkey` 严格指向 `babies(family_id, id)` (`ON DELETE CASCADE`)；
   - 建立 CHECK 约束：`version > 0`；
   - 建立时间线索引 `ix_supplement_records_baby_timeline` (`baby_id, deleted_at, occurred_at DESC, id DESC`)。

2. **仓储与领域服务**：
   - `ScopedSupplementRepository` (`packages/database/src/supplement-repository.ts`)：依托 `executeFamilyUnitOfWork` 事务框架，原子更新时间线投影 `TimelineEntry`（`entityType: "supplement"`），支持 Keyset 复合游标分页 (`occurredAt DESC, id DESC`) 与并发 `baseVersion` 乐观锁；
   - `SupplementService` (`apps/api/src/services/supplement-service.ts`)：逐宝宝权限校验、Keyset 游标编排、幂等凭据处理与事务协调。

3. **API 路由层**：
   - 挂载 5 个 RESTful 端点 (`apps/api/src/routes/supplement-routes.ts`)：
     - `GET /api/v1/babies/:babyId/records/supplement` (游标分页列表)
     - `POST /api/v1/babies/:babyId/records/supplement` (创建补剂记录，支持 Idempotency-Key)
     - `GET /api/v1/babies/:babyId/records/supplement/:id` (获取单条记录)
     - `PATCH /api/v1/babies/:babyId/records/supplement/:id` (更新记录，带 baseVersion 乐观锁)
     - `DELETE /api/v1/babies/:babyId/records/supplement/:id` (软删除，同步软删除时间线投影)

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 添加 `SupplementRecord` 模型与 `Family`/`Baby` 反向关联 |
| `prisma/migrations/202609120007_care_supplement/migration.sql` | 新增 | PostgreSQL 18 物理迁移：`supplement_records` 表、复合外键、CHECK 约束与时间线索引 |
| `packages/database/src/supplement-repository.ts` | 新增 | 补剂仓储（UoW 事务、时间线原子投影、乐观锁、游标分页） |
| `packages/database/src/index.ts` | 修改 | 导出 `supplement-repository.ts` |
| `apps/api/src/services/supplement-service.ts` | 新增 | 补剂领域服务（权限校验、游标编排、数据映射） |
| `apps/api/src/routes/supplement-routes.ts` | 新增 | 补剂记录 5 个 RESTful 端点 |
| `apps/api/src/app.ts` | 修改 | 注册 Supplement 相关 schemas 与 `supplementRoutes` 路由插件 |
| `tests/integration/foundation-migration.test.ts` | 修改 | 基础迁移测试中增加 0007 迁移与 `supplement_records` 表验证 |
| `tests/integration/supplement.test.ts` | 新增 | 8 项针对真实 PG18 的补剂管道完整测试（SU-01~07 及 Setup） |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `supplement.test.ts` |
| `evidence/tasks/SH-04SU/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:build
npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)

npm run backend:lint
# Output:
# Architecture check passed (79 TypeScript source files).
```

### 3.2 契约一致性校验（零差异）
```bash
node scripts/check-contracts.mjs
# Output:
# Checking canonical OpenAPI specification consistency...
# Contract check passed: /Users/wangzhuo/Documents/GitHub/growdesk-server/contracts/openapi.json is perfectly in sync (86 paths, 122 operations).
```

### 3.3 单元测试套件（84 项通过）
```bash
npm run backend:test:unit
# Output:
# ℹ tests 84
# ℹ suites 1
# ℹ pass 84
# ℹ fail 0
```

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（118 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-04SU: Supplement Record Pipeline suite
#   ✔ Setup: Register User A and User B, create families and babies (946.315958ms)
#   ✔ SU-01: Create supplement record with timeline projection (30.960625ms)
#   ✔ SU-02: Idempotency replay with same key returns cached result (4.94325ms)
#   ✔ SU-03: Reusing Idempotency-Key with different payload triggers 409 (5.564792ms)
#   ✔ SU-04: Keyset pagination works stably across supplement records (52.114459ms)
#   ✔ SU-05: Optimistic locking detects concurrency conflicts on baseVersion (31.401542ms)
#   ✔ SU-06: User B cannot access or modify Baby A's supplement records (403) (9.154792ms)
#   ✔ SU-07: Delete supplement record soft-deletes and removes active timeline projection (15.094041ms)
# ✔ SH-04SU: Supplement Record Pipeline suite (1294.0985ms)
# ℹ tests 118
# ℹ pass 118
# ℹ fail 0
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

---

## 4. 交付物与前置解除

- `SH-04SU` 实施与自动化测试已全部完成。
- 为后续任务解除前置：
  - `SH-04G`: 成长记录链路与 WHO 百分位计算引擎 (Growth Record Pipeline & WHO Percentiles)
  - `SH-04TL`: 统一时间线检索与聚合查询 (Unified Timeline Pipeline)
