# 任务执行报告：SH-04S 睡眠记录链路 (Sleep Record Pipeline)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`ffbbb2e` (SH-04D)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A`、`SH-03C`、`SH-04F`、`SH-04D` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节（SH-04 任务卡）及 `02_BACKEND_CONTRACTS.md` 规范，实施 **SH-04S 睡眠记录链路**：

1. **数据库迁移与模型 (`202609120005_care_sleep`)**：
   - 在 `prisma/schema.prisma` 新增 `SleepRecord` 模型，包含 `sleepType` ("nap" | "night")、`startedAt`、`endedAt` (可空，表示进行中的睡眠)、`nightWakingCount`、`notes`、`source`、`sourceAgent`、`version`、`deletedAt`；
   - 建立复合外键约束 `fk_sleep_records_family_id_baby_id_fkey` 严格指向 `babies(family_id, id)` (`ON DELETE CASCADE`)；
   - 建立 CHECK 约束 `sleep_records_sleep_type_check` (`sleep_type IN ('nap', 'night')`)；
   - 建立 CHECK 约束 `sleep_records_version_check` (`version > 0`)；
   - 建立 CHECK 约束 `sleep_records_night_waking_count_check` (`night_waking_count >= 0`)；
   - 建立 CHECK 约束 `sleep_records_ended_after_started_check` (`ended_at IS NULL OR ended_at >= started_at`)；
   - 建立**全局进行中睡眠硬互斥部分唯一索引**：
     `CREATE UNIQUE INDEX "uq_sleep_records_active_baby" ON "sleep_records"("baby_id") WHERE ("ended_at" IS NULL AND "deleted_at" IS NULL);`
     在数据库引擎层防止同一个宝宝并发开启两个进行中的睡眠会话；
   - 建立时间线高效查询索引 `ix_sleep_records_baby_timeline` (`baby_id, deleted_at, started_at DESC, id DESC`) 与家庭维度索引 `ix_sleep_records_family_timeline`。

2. **睡眠仓储与领域服务**：
   - 实现 `ScopedSleepRepository` (`packages/database/src/sleep-repository.ts`)，全面依托 `executeFamilyUnitOfWork` 事务框架；
   - 支持创建 (`create`，自动检查进行中会话互斥)、更新 (`update`，校验 `endedAt >= startedAt` 并处理状态流转)、软删除 (`delete`)、恢复 (`restore`)、按 ID 查询 (`findById`)、查询宝宝当前进行中睡眠 (`findActiveByBaby`)、Keyset 游标倒序分页列表 (`listByBaby`)；
   - 映射实体及 UoW payload 包含 `sleepType`、`startedAt`、`endedAt`、`nightWakingCount`、`version`，生成概要 `Sleep: ${sleepType} (finished / in progress)`。

3. **API 路由与服务层**：
   - 实施 `SleepService` (`apps/api/src/services/sleep-service.ts`)，挂载在 `apps/api/src/routes/sleep-routes.ts`；
   - 挂载 5 个 RESTful 端点：
     - `GET /api/v1/babies/:babyId/records/sleep`
     - `POST /api/v1/babies/:babyId/records/sleep`
     - `GET /api/v1/babies/:babyId/records/sleep/:id`
     - `PATCH /api/v1/babies/:babyId/records/sleep/:id`
     - `DELETE /api/v1/babies/:babyId/records/sleep/:id`
   - **进行中状态与互斥**：支持 `endedAt` 为 null 创建睡眠中会话，若已存在未结束睡眠则抛出 409 `ACTIVE_SLEEP_EXISTS`；
   - **跨夜睡眠区间合法性**：支持跨午夜有效区间（如 21:00 至次日 06:30），若 `endedAt < startedAt` 则严格返回 400 `INVALID_SLEEP_INTERVAL`；
   - **逐宝宝权限隔离**：严格通过 `BabyMember(active)` 和 `FamilyMember(active)` 校验，Viewer 只读，Admin/Caregiver 可写；
   - **时间线投影原子性**：创建与修改操作原子更新 `TimelineEntry`，软删除时原子软删除 `TimelineEntry`；
   - **幂等性与重放**：`POST` 请求支持 `Idempotency-Key`，相同 key 和相同 payload 重放返回缓存结果，不同 payload 返回 409 `IDEMPOTENCY_KEY_REUSED`；
   - **乐观锁控制**：结束睡眠或修改数据通过 `PATCH` 携带 `baseVersion`，若发生双设备并发结束则第二台设备返回 409 `CONCURRENCY_CONFLICT`；
   - **Keyset 游标分页**：列表接口支持以 `started_at DESC, id DESC` 复合游标分页。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 添加 `SleepRecord` 模型与 `Family`/`Baby` 反向关联 |
| `prisma/migrations/202609120005_care_sleep/migration.sql` | 新增 | PostgreSQL 18 物理迁移：`sleep_records` 表、复合外键、进行中唯一索引、CHECK 约束与时间线索引 |
| `packages/database/src/sleep-repository.ts` | 新增 | 睡眠记录仓储层与 UoW 事务原子封装 |
| `packages/database/src/index.ts` | 修改 | 导出 `sleep-repository.ts` 与 `ScopedSleepRepository` 别名 |
| `apps/api/src/services/sleep-service.ts` | 新增 | 睡眠领域服务（权限校验、时间区间校验、活跃会话查询、游标分页、UoW 编排） |
| `apps/api/src/routes/sleep-routes.ts` | 新增 | 睡眠记录 5 个 REST 路由 |
| `apps/api/src/app.ts` | 修改 | 注册 `SleepRecordSchema`、`SleepRecordResponseSchema`、`SleepListResponseSchema` 及 `sleepRoutes` |
| `tests/integration/foundation-migration.test.ts` | 修改 | 基础迁移测试中增加 0005 迁移与 `sleep_records` 表验证 |
| `tests/integration/sleep.test.ts` | 新增 | 12 项针对真实 PG18 的睡眠管道完整测试（S-01~10 及两组 Setup） |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `sleep.test.ts` |
| `evidence/tasks/SH-04S/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)

npm run backend:lint
# Output:
# Architecture check passed (73 TypeScript source files).
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
# ℹ pass 84
# ℹ fail 0
```

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（96 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-04S: Sleep Record Pipeline suite
#   ✔ Setup: Register User A and create Baby A (1649.361333ms)
#   ✔ Setup: Register User B and create Baby B (140.999125ms)
#   ✔ S-01: Create ongoing sleep record with timeline projection (61.426875ms)
#   ✔ S-02: Creating second active sleep while first ongoing fails with 409 (22.203709ms)
#   ✔ S-03: Idempotency replay returns cached ongoing sleep (9.827167ms)
#   ✔ S-04: End sleep session via PATCH with endedAt (47.465167ms)
#   ✔ S-05: Concurrency conflict 409 on outdated baseVersion (15.463459ms)
#   ✔ S-06: Create finished sleep with cross-midnight interval (23.169209ms)
#   ✔ S-07: Invalid interval (endedAt < startedAt) rejected with 400 (9.158958ms)
#   ✔ S-08: Keyset pagination works stably across sleep records (43.706583ms)
#   ✔ S-09: Multi-tenant cross-baby isolation (9.880083ms)
#   ✔ S-10: Soft-delete removes record and timeline projection (20.991958ms)
# ✔ SH-04S: Sleep Record Pipeline suite (2520.286084ms)
# ℹ tests 96
# ℹ pass 96
# ℹ fail 0
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

---

## 4. 交付物与状态确认

- 代码实现遵循全部技术约束：0 `any`，依赖倒置，无 SQLite 渗透；
- 生产环境硬隔离：完全基于隔离 PostgreSQL 18，测试租户全部采用 `test_*` 命名；
- 未提交历史文件保持原样未动：
  - `deploy/Migration.Dockerfile`
  - `evidence/tasks/LEGACY_IMPORT/*`
  - `scripts/legacy-import/ios_backup.py`
  - `scripts/legacy-import/test_ios_backup.py`
- 准备提交并在 `baby_panel_for_cecilia` 的 `evidence/long-run/PROGRESS.md` 同步进度；
- 紧接着按任务链推进：**SH-04FO (辅食记录链路 / Food Record Pipeline)**。
