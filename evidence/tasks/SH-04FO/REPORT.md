# 任务执行报告：SH-04FO 辅食记录链路与食材库 (Food Record Pipeline & Ingredients Catalog)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`4d74f31` (SH-04S)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A`、`SH-03C`、`SH-04F`、`SH-04D`、`SH-04S` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节（SH-04 任务卡）及 `02_BACKEND_CONTRACTS.md` 规范，实施 **SH-04FO 辅食记录链路与食材库**：

1. **数据库迁移与模型 (`202609120006_care_food`)**：
   - `food_records` 表：记录宝宝辅食日志，包含 `record_date` (`YYYY-MM-DD`)、`meal_type` ("breakfast" | "lunch" | "dinner" | "snack")、`occurred_at`、`food_item_ids` (数组)、`portion_description`、`reaction` ("like" | "normal" | "dislike")、`notes`、`version`、`deleted_at`；
   - `food_library_items` 表：食材库标准项与自定义项（`is_custom`, `family_id`），包含 `allergen_risk` ("low" | "medium" | "high")、`recommended_age_months`；
   - `family_food_statuses` 表：家庭维度食材尝试状态跟踪（`tried`, `reaction`），以 `(family_id, food_item_id)` 唯一；
   - `baby_food_plans` 表：宝宝专属辅食计划（`plan_data` JSONB），严格绑定 `(family_id, baby_id)` 复合外键；
   - 建立复合外键约束 `fk_food_records_family_id_baby_id_fkey` 严格指向 `babies(family_id, id)` (`ON DELETE CASCADE`)；
   - 建立 CHECK 约束：`meal_type`、`reaction`、`version > 0`、`allergen_risk`、`recommended_age_months >= 0`；
   - 建立时间线高效查询索引 `ix_food_records_baby_timeline` (`baby_id, deleted_at, record_date DESC, id DESC`)。

2. **仓储与领域服务**：
   - `ScopedFoodRepository` (`packages/database/src/food-repository.ts`)：依托 `executeFamilyUnitOfWork` 事务框架，原子更新时间线投影 `TimelineEntry`，支持 Keyset 复合游标分页 (`recordDate DESC, id DESC`) 与并发 `baseVersion` 乐观锁；
   - `FoodLibraryRepository`：多租户食材库查询与自定义食材添加，自动聚合家庭维度的尝试与耐受状态；
   - `FoodPlanRepository`：按宝宝原子保存与读取辅食周/月计划；
   - `FoodService` (`apps/api/src/services/food-service.ts`)：逐宝宝权限校验、Keyset 游标编排、静态临床指南 (`CLINICAL_FOOD_GUIDELINES`) 服务。

3. **API 路由层**：
   - 挂载 10 个 RESTful 端点 (`apps/api/src/routes/food-routes.ts`)：
     - `GET /api/v1/babies/:babyId/records/food` (游标分页列表)
     - `POST /api/v1/babies/:babyId/records/food` (创建辅食记录，支持 Idempotency-Key)
     - `GET /api/v1/babies/:babyId/records/food/:id` (获取单条记录)
     - `PATCH /api/v1/babies/:babyId/records/food/:id` (更新记录，带 baseVersion 乐观锁)
     - `DELETE /api/v1/babies/:babyId/records/food/:id` (软删除，同步软删除时间线投影)
     - `GET /api/v1/food/items` (获取食材库列表并包含家庭尝试状态)
     - `POST /api/v1/food/items` (创建家庭自定义食材)
     - `GET /api/v1/food/guidelines` (获取月龄辅食临床引入指南)
     - `GET /api/v1/babies/:babyId/food-plan` (获取宝宝辅食计划)
     - `PUT /api/v1/babies/:babyId/food-plan` (保存宝宝辅食计划)

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 添加 `FoodRecord`、`FoodLibraryItem`、`FamilyFoodStatus`、`BabyFoodPlan` 模型与关联 |
| `prisma/migrations/202609120006_care_food/migration.sql` | 新增 | PostgreSQL 18 物理迁移：4 张数据表、复合外键、CHECK 约束与时间线索引 |
| `packages/database/src/food-repository.ts` | 新增 | 辅食仓储、食材库仓储与辅食计划仓储 |
| `packages/database/src/index.ts` | 修改 | 导出 `food-repository.ts` |
| `apps/api/src/services/food-service.ts` | 新增 | 辅食领域服务（权限校验、游标编排、临床指南） |
| `apps/api/src/routes/food-routes.ts` | 新增 | 辅食记录与营养食材库 10 个 REST 端点 |
| `apps/api/src/app.ts` | 修改 | 注册 Food 相关 schemas 与 `foodRoutes` 路由插件 |
| `tests/integration/foundation-migration.test.ts` | 修改 | 基础迁移测试中增加 0006 迁移与 4 张新表结构验证 |
| `tests/integration/food.test.ts` | 新增 | 13 项针对真实 PG18 的辅食管道完整测试（FO-01~10 及 Setup） |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `food.test.ts` |
| `evidence/tasks/SH-04FO/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)

npm run backend:lint
# Output:
# Architecture check passed (76 TypeScript source files).
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

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（109 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-04FO: Food Record Pipeline suite
#   ✔ Setup: Register User A and create Baby A (2054.216542ms)
#   ✔ Setup: Register User B and create Baby B (258.006291ms)
#   ✔ FO-01: Create food record creates entity and timeline projection (49.930791ms)
#   ✔ FO-02: Idempotent replay with same key returns cached result (7.328917ms)
#   ✔ FO-03: Reusing Idempotency-Key with different payload triggers 409 (8.36425ms)
#   ✔ FO-04: Keyset pagination works stably across food records (46.04125ms)
#   ✔ FO-05: Optimistic locking detects concurrency conflicts (62.719875ms)
#   ✔ FO-06: User B cannot access or modify Baby A's food records (44.087333ms)
#   ✔ FO-07: Delete food record soft-deletes and removes active timeline (34.922458ms)
#   ✔ FO-08: Food Library Items management (43.275042ms)
#   ✔ FO-09: Food Guidelines returns age-stage guidance (7.121792ms)
#   ✔ FO-10: Baby Food Plan save and get with tenant isolation (61.727542ms)
# ✔ SH-04FO: Food Record Pipeline suite (3274.590792ms)
# ℹ tests 109
# ℹ pass 109
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
- 紧接着按任务链推进：**SH-04SU (补剂记录链路 / Supplement Record Pipeline)**。
