# 任务执行报告：SH-04F 喂养记录链路与配方奶产品库

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`ba462a9` (SH-03D)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A`、`SH-03C` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节（SH-04 任务卡）及 `02_BACKEND_CONTRACTS.md` 第 4.1/4.2 节规范，实施 **SH-04F 喂养记录链路与配方奶产品库**：

1. **数据库迁移与模型 (`202609120003_care_feeding`)**：
   - 在 `prisma/schema.prisma` 新增 `FormulaProduct` 模型，包含 `scoopGrams Decimal(12, 5)`、`waterMlPerScoop Decimal(12, 5)`、家庭级多租户隔离、软删除支持；
   - 建立 `feeding_records.formula_product_id` 指向 `formula_products.id` 外键约束 (`ON DELETE SET NULL`)；
   - 扩充 `feeding_records.feeding_type` 校验约束以全面支持标准规范喂养类型 (`breast`, `bottle`, `formula`) 与兼容历史遗留类型；
   - 建立索引 `ix_formula_products_family`。

2. **配方奶产品库管理接口 (`/api/v1/families/:familyId/nutrition/products`)**：
   - 挂载 4 个端点：列表 (`GET`)、创建 (`POST`)、修改 (`PATCH`)、删除 (`DELETE`)；
   - 实施 `FormulaProductService` 与 `ScopedFormulaProductRepository`，严格校验调用方对家庭的写/管理权限（Admin/Member 可写，Viewer 只读）；
   - 产品库在家庭边界内隔离，软删除标记 `deleted_at = NOW()`。

3. **喂养记录管道接口 (`/api/v1/babies/:babyId/records/feeding`)**：
   - 挂载 5 个端点：列表 (`GET`)、创建 (`POST`)、获取单条 (`GET /:id`)、修改 (`PATCH /:id`)、删除 (`DELETE /:id`)；
   - 实施 `FeedingService` 与 `ScopedFeedingRepository`，底层依托 `executeFamilyUnitOfWork` 事务框架；
   - **逐宝宝权限校验**：严格验证调用者持有 `FamilyMember(active)` 且持有目标宝宝的 `BabyMember(active)`，Viewer 仅可读，非 Viewer 具备记录读写权限；
   - **配方奶跨家庭边界防御**：当喂养记录指定 `formulaProductId` 时，严格验证该产品归属于该宝宝所在的 `familyId` 且未被软删除；跨家庭或不存在立即阻断并返回 400 `FORMULA_PRODUCT_NOT_FOUND`；
   - **时间线投影原子性**：创建与修改操作原子更新 `TimelineEntry`，软删除时原子软删除对应的 `TimelineEntry`；
   - **幂等性与重放**：`POST` 请求支持 `Idempotency-Key` 头，相同 key 和相同 payload 重放返回缓存结果，不同 payload 返回 409 `IDEMPOTENCY_KEY_REUSED`；
   - **乐观锁控制**：`PATCH` 更新携带 `baseVersion`，发生版本不一致时返回 409 `CONCURRENCY_CONFLICT`；
   - **Keyset 游标分页**：列表接口支持以 `occurred_at DESC, id DESC` 复合游标分页，保证大量数据下稳定的高性能翻页与无跳页表现。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 添加 `FormulaProduct` 模型与关联 |
| `prisma/migrations/202609120003_care_feeding/migration.sql` | 新增 | PostgreSQL 18 物理迁移：`formula_products` 表、外键约束、CHECK 扩充与索引 |
| `packages/database/src/formula-product-repository.ts` | 新增 | 配方奶产品仓储层与多租户隔离查询 |
| `packages/database/src/feeding-repository.ts` | 修改 | 喂养仓储增强：支持恢复操作、UncheckedUpdateInput 与类型导出 |
| `packages/database/src/index.ts` | 修改 | 导出配方奶仓储与喂养仓储别名 |
| `packages/contracts/src/common.ts` | 修改 | 导出 `BabyIdParamSchema`, `BabyAndIdParamSchema`, `FamilyIdParamSchema`, `FamilyAndProductParamSchema` |
| `apps/api/src/services/formula-product-service.ts` | 新增 | 配方奶产品领域服务 |
| `apps/api/src/services/feeding-service.ts` | 新增 | 喂养记录管道服务（游标分页、配方奶校验、UoW 操作编排） |
| `apps/api/src/routes/formula-product-routes.ts` | 新增 | 配方奶产品 4 个 REST 路由 |
| `apps/api/src/routes/feeding-routes.ts` | 新增 | 喂养记录 5 个 REST 路由 |
| `apps/api/src/app.ts` | 修改 | 注册配方奶与喂养全部 TypeBox Schemas 及路由模块 |
| `tests/integration/foundation-migration.test.ts` | 修改 | 基础迁移测试中增加 0003 迁移验证 |
| `tests/integration/feeding.test.ts` | 新增 | 13 项针对真实 PG18 的配方奶与喂养管道完整测试（FP-01/02, FEED-01~08） |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `feeding.test.ts` |
| `evidence/tasks/SH-04F/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)

npm run backend:lint
# Output:
# Architecture check passed (67 TypeScript source files).
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

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（72 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-04F: Feeding Record Pipeline & Formula Products suite
#   ✔ Setup: Register User A and create Baby A (947.801541ms)
#   ✔ Setup: Register User B in separate Family B (92.838625ms)
#   ✔ FP-01: Create formula product in Family A catalog (11.168583ms)
#   ✔ FP-02: List formula products adheres to family boundary (13.782042ms)
#   ✔ FEED-01: Create feeding record creates entity and atomic timeline projection (38.237833ms)
#   ✔ FEED-02: Same Idempotency-Key and payload returns replayed result (10.087041ms)
#   ✔ FEED-03: Reusing Idempotency-Key with different payload triggers 409 (5.407958ms)
#   ✔ FEED-04: Formula product from another family is rejected (10.186083ms)
#   ✔ FEED-05: Keyset pagination works stably (62.053458ms)
#   ✔ FEED-06: Optimistic locking detects concurrency conflicts (29.654459ms)
#   ✔ FEED-07: User B cannot access or modify Baby A's feeding records (17.652459ms)
#   ✔ FEED-08: Delete feeding record soft-deletes and removes timeline projection (34.779167ms)
# ✔ SH-04F: Feeding Record Pipeline & Formula Products suite (1542.588917ms)
# ℹ tests 72
# ℹ pass 72
# ℹ fail 0
```

---

## 4. 结论与后续

- **结论**：`SH-04F` 喂养记录管道及配方奶产品库已在 `growdesk-server` 完整实现并通过所有 84 项单元测试和 72 项独立 PostgreSQL 18 / Redis 集成测试。
- **下一项任务**：`SH-04D`：实施尿布记录链路 (`/api/v1/babies/:babyId/records/diaper`)。
