# 任务执行报告：SH-04G 成长记录链路与 WHO 百分位引擎 (Growth Record Pipeline & WHO Percentiles)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`aa885bc` (SH-04SU)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A`、`SH-03C`、`SH-04F`、`SH-04D`、`SH-04S`、`SH-04FO`、`SH-04SU` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节（SH-04 任务卡）及 `02_BACKEND_CONTRACTS.md` 规范，实施 **SH-04G 成长记录链路与 WHO 百分位引擎**：

1. **WHO 生长标准与百分位计算引擎 (`packages/domain/src/who-growth-standards.ts`)**：
   - 完整收录 WHO 0–36 月龄男童与女童生长发育标准数据集（包含体重 kg、身长/身高 cm、头围 cm 在 P3、P15、P50、P85、P97 的离散基准点）；
   - 实现月龄线性插值与连续百分位估算函数 `estimatePercentile`；
   - 实现生长图表 WHO 百分位覆盖线生成函数 `buildWhoGrowthChartSet`，按宝宝性别输出各月龄精确小数序列。

2. **数据库迁移与模型 (`202609120008_care_growth`)**：
   - `growth_measurements` 表：记录宝宝身体发育测量数据，包含 `measurement_date` (DATE)、`weight_kg` (NUMERIC(5,2))、`height_cm` (NUMERIC(5,1))、`head_circumference_cm` (NUMERIC(4,1))、`attachment_id`、`notes`、`version`、`deleted_at`、`created_at`、`updated_at`；
   - 建立复合外键约束 `fk_growth_measurements_family_id_baby_id_fkey` 严格指向 `babies(family_id, id)` (`ON DELETE CASCADE`)；
   - 建立 CHECK 约束：`version > 0`、至少包含一项有效测量值 (`weight_kg IS NOT NULL OR height_cm IS NOT NULL OR head_circumference_cm IS NOT NULL`)、各项非负数检查；
   - 建立时间线高效查询索引 `ix_growth_measurements_baby_timeline` (`baby_id, deleted_at, measurement_date DESC, id DESC`)。

3. **仓储与领域服务**：
   - `ScopedGrowthRepository` (`packages/database/src/growth-repository.ts`)：依托 `executeFamilyUnitOfWork` 事务框架，原子更新时间线投影 `TimelineEntry`（`entityType: "growth"`），支持 Keyset 复合游标分页 (`measurementDate DESC, id DESC`)、`baseVersion` 乐观并发锁、图表全量升序查询 `listAllForChart`；
   - `GrowthService` (`apps/api/src/services/growth-service.ts`)：逐宝宝权限校验、Keyset 游标编排、WHO 图表标准线合成与数据映射。

4. **API 路由层**：
   - 挂载 6 个 RESTful 端点 (`apps/api/src/routes/growth-routes.ts`)：
     - `GET /api/v1/babies/:babyId/growth-measurements` (游标分页列表)
     - `POST /api/v1/babies/:babyId/growth-measurements` (创建测量记录，支持 Idempotency-Key)
     - `GET /api/v1/babies/:babyId/growth-measurements/:id` (获取单条记录)
     - `PATCH /api/v1/babies/:babyId/growth-measurements/:id` (更新记录，带 baseVersion 乐观锁)
     - `DELETE /api/v1/babies/:babyId/growth-measurements/:id` (软删除，同步软删除时间线投影)
     - `GET /api/v1/babies/:babyId/growth-chart` (获取历史测量点叠加对应性别的 WHO 标准生长曲线)

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `packages/domain/src/who-growth-standards.ts` | 新增 | WHO 0-36 月龄标准百分位数据集与插值计算引擎 |
| `packages/domain/src/index.ts` | 修改 | 导出 `who-growth-standards.ts` |
| `prisma/schema.prisma` | 修改 | 添加 `GrowthMeasurement` 模型与 `Family`/`Baby` 关联 |
| `prisma/migrations/202609120008_care_growth/migration.sql` | 新增 | PostgreSQL 18 物理迁移：`growth_measurements` 表、复合外键、CHECK 约束与时间线索引 |
| `packages/database/src/growth-repository.ts` | 新增 | 成长仓储（UoW 事务、时间线原子投影、乐观锁、游标分页、图表查询） |
| `packages/database/src/index.ts` | 修改 | 导出 `growth-repository.ts` |
| `apps/api/src/services/growth-service.ts` | 新增 | 成长领域服务（权限校验、游标编排、WHO 曲线合成） |
| `apps/api/src/routes/growth-routes.ts` | 新增 | 成长记录与生长曲线 6 个 RESTful 端点 |
| `apps/api/src/app.ts` | 修改 | 注册 Growth 相关 schemas 与 `growthRoutes` 路由插件 |
| `tests/integration/foundation-migration.test.ts` | 修改 | 基础迁移测试中增加 0008 迁移与 `growth_measurements` 表验证 |
| `tests/integration/growth.test.ts` | 新增 | 9 项针对真实 PG18 的成长管道完整测试（G-01~08 及 Setup） |
| `tests/integration/supplement.test.ts` | 修改 | 修复 lint prefer-const 提示 |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `growth.test.ts` |
| `evidence/tasks/SH-04G/REPORT.md` | 新增 | 本任务执行报告 |

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
# Architecture check passed (83 TypeScript source files).
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

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（128 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-04G: Growth Measurement Pipeline & WHO Percentiles suite
#   ✔ Setup: Register User A and User B, create families and babies (3073.09225ms)
#   ✔ G-01: Create growth measurement with timeline projection (69.810125ms)
#   ✔ G-02: Idempotency replay with same key returns cached result (18.596333ms)
#   ✔ G-03: Reusing Idempotency-Key with different payload triggers 409 (19.921166ms)
#   ✔ G-04: Keyset pagination works stably across growth measurements (196.829625ms)
#   ✔ G-05: Optimistic locking detects concurrency conflicts on baseVersion (77.822ms)
#   ✔ G-06: User B cannot access or modify Baby A's growth measurements (403) (84.687ms)
#   ✔ G-07: Delete growth measurement soft-deletes and removes active timeline projection (33.090958ms)
#   ✔ G-08: Get Growth Chart returns historical measurements overlaid with WHO percentiles (35.974542ms)
# ✔ SH-04G: Growth Measurement Pipeline & WHO Percentiles suite (4234.772959ms)
# ℹ tests 128
# ℹ pass 128
# ℹ fail 0
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

---

## 4. 交付物与前置解除

- `SH-04G` 实施与自动化测试已全部完成。
- 为后续任务解除前置：
  - `SH-04TL`: 统一时间线检索与聚合查询 (Unified Timeline Pipeline)
  - `SH-05`: Web BFF 架构与首条联调链路
