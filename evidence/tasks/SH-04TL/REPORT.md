# 任务执行报告：SH-04TL 统一时间线检索与聚合查询 (Unified Timeline Pipeline)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`0eb87ca` (SH-04G)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A`、`SH-03C`、`SH-04F`、`SH-04D`、`SH-04S`、`SH-04FO`、`SH-04SU`、`SH-04G` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节（SH-04 任务卡）及 `02_BACKEND_CONTRACTS.md` 规范，实施 **SH-04TL 统一时间线检索与聚合查询链路**：

1. **时间线持久化与原子投影仓储 (`packages/database/src/timeline-repository.ts`)**：
   - 强化 `ScopedTimelineRepository`（`TimelineRepository`）的 `listByBabyKeyset` 检索能力；
   - 支持 `entityType`（`feeding`、`diaper`、`sleep`、`food`、`supplement`、`growth`）可选单域过滤；
   - 采用稳定高效的 Keyset 复合游标分页机制：基于 `(occurred_at DESC, id DESC)` 倒序排列；
   - 严格保证只读取未被软删除（`deletedAt IS NULL`）的活跃时间线记录。

2. **时间线领域服务 (`apps/api/src/services/timeline-service.ts`)**：
   - 实现 `TimelineService`，依托 `ScopedFamilyAuthorizationRepository` 验证调用方是否具有该宝宝的有效活跃访问授权（`BabyMember`）；
   - 实现 Base64URL 格式 Keyset 游标编解码（`encodeTimelineKeysetCursor` / `decodeTimelineKeysetCursor`），防止页面翻页越界或伪造；
   - 对 6 大护理领域投影出的 `TimelineEntry` 执行规范化类型转换与响应封装。

3. **API 路由层 (`apps/api/src/routes/timeline-routes.ts` & `apps/api/src/app.ts`)**：
   - 挂载 RESTful 端点：`GET /api/v1/babies/:babyId/timeline`；
   - 支持查询参数：`limit` (1~100)、`cursor` (Keyset string)、`entityType` (枚举可选)；
   - 在 `app.ts` 中注册 `TimelineEntrySchema`、`TimelineResponseSchema` 并加载路由。

4. **端到端集成测试 (`tests/integration/timeline.test.ts`)**：
   - `TL-01`：在 User A 视角下，依次写入 6 大护理领域事件（配方奶喂养、换尿布、小睡、午餐辅食、维生素D3补剂、体格测量），验证时间线表完整聚合且包含全部 6 种 `entityType`；
   - `TL-02`：进行 Keyset 复合游标分页测试，验证按 `occurredAt DESC, id DESC` 分页无重复、无遗漏且游标平滑推进；
   - `TL-03`：软删除单条喂养记录，验证时间线中对应的投影原子消失，其余 5 条记录保持完整；
   - `TL-04`：跨租户安全隔离验证，确认 User B（无权限）访问 Baby A 时间线直接被拒绝并返回 `403`。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `packages/database/src/timeline-repository.ts` | 修改 | 支持 `entityType` 单域筛选与 `BabyMember` 权限关联 |
| `apps/api/src/services/timeline-service.ts` | 新增 | 时间线业务逻辑服务（逐宝宝鉴权、游标编解码、DTO 映射） |
| `apps/api/src/routes/timeline-routes.ts` | 新增 | 时间线聚合检索 HTTP 端点 `GET /api/v1/babies/:babyId/timeline` |
| `apps/api/src/app.ts` | 修改 | 注册时间线 Schema 与路由插件 |
| `tests/integration/timeline.test.ts` | 新增 | 4 项针对真实 PG18 的统一时间线端到端测试（TL-01~04） |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `timeline.test.ts` |
| `evidence/tasks/SH-04TL/REPORT.md` | 新增 | 本任务执行报告 |

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
# Architecture check passed (85 TypeScript source files).
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

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（134 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-04TL: Unified Timeline Pipeline suite
#   ✔ Setup: Register User A and User B, create families and babies (1053.369625ms)
#   ✔ TL-01: Create events across 6 care domains and verify timeline projection (163.839875ms)
#   ✔ TL-02: Keyset pagination works stably across multi-domain timeline entries (12.076459ms)
#   ✔ TL-03: Soft-deleting a care record removes it from timeline (22.1205ms)
#   ✔ TL-04: Multi-tenant cross-baby isolation (403) (5.6515ms)
# ✔ SH-04TL: Unified Timeline Pipeline suite (1649.387584ms)
# ℹ tests 134
# ℹ suites 0
# ℹ pass 134
# ℹ fail 0
```

---

## 4. 结论与下一步

SH-04TL（统一时间线检索与聚合查询）已全部完成并通过完整集成验证，至此 L3 层的全部护理记录领域（SH-04F、SH-04D、SH-04S、SH-04FO、SH-04SU、SH-04G、SH-04TL）全部交付完毕。
接下来将推进至下一阶段任务：
- SH-04A: S3 附件上传直传与下载凭证链路 (Attachments Pipeline)
- 或 SH-05: Web BFF 和第一条联调链路 (Web BFF & First Integration Pipeline)
