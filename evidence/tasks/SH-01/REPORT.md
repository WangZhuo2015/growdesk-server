# 任务执行报告：SH-01 契约和 Web 兼容矩阵

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`d9604d5a773630e81c0bedcc70b7bcf013c64535`  
> 依赖前置：`SH-00`（已完成并通过 R0 修正）

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 6 节（SH-01）及 `02_BACKEND_CONTRACTS.md`、`docs/compat/web-api-mapping.md` 约束，在 `growdesk-server` 实现单一权威 TypeBox 契约、生成 OpenAPI 3.0.3 规范，并建立零漂移（zero-diff）CI 检查与 Swift 6 兼容性验证闭环。

### 核心交付物：
1. **模块化 TypeBox 契约架构**（位于 `packages/contracts/src/`）：
   - `common.ts`：标准错误信封（`ApiErrorEnvelope`）、成功信封（`SuccessEnvelope`）、分页信封（`PaginatedEnvelope`）、RFC3339 时间（`DateTimeString`）、日历日期（`DateString`）、十进制小数字符串（`DecimalString`）、64位整数字符串（`BigIntString`）、UUID 格式及 `FormatRegistry` 格式校验。
   - `health.ts`：健康检查契约（`HealthLiveResponse`、`HealthReadyResponse`），保持 BOOT-02 向后兼容。
   - `auth.ts`：注册、登录、原子刷新轮换、会话撤销、密码修改、恢复码（10个128-bit随机码）、密码找回、BFF托管会话置换（`exchangeBffSession`）。
   - `user.ts`：个人资料（`UserProfile`）、资料更新、用户数据导出任务（2022 Accepted）、账号删除。
   - `family.ts`：家庭管理、时区配置、成员角色权限、邀请码生命周期（`createFamilyInvite`、`previewFamilyInvite`、`joinFamily`）、宝宝档案多对多绑定（`Baby`、`BabyMember`）。
   - `records.ts`：喂养（`feeding`：SH-04F）、睡眠（`sleep`：SH-04S，支持活跃睡眠 `endedAt=null`）、尿布（`diaper`：SH-04D）、辅食（`food`：SH-04FO）、营养补充剂（`supplement`）、时间线统一投影（`TimelineEntry`）及向后兼容的 Swift 鉴别联合样例（`TimelineEvent`）。
   - `growth.ts`：体格发育测量（`GrowthMeasurement`，`weightKg`、`heightCm`、`headCircumferenceCm` 均为十进制字符串）、WHO 百分位图表点数据、向后兼容样例（`GrowthRecord`）。
   - `medical.ts`：医疗门诊与检查报告（`MedicalReport`）、医疗 OCR 异步任务（`createMedicalOcrRun`）、国家免疫规划疫苗表与接种记录。
   - `ai.ts`：私有 AI 会话、消息流、AI 执行 Run 状态机（`queued`、`running`、`awaiting_confirmation`、`succeeded`、`failed`、`cancelling`、`cancelled`）、工具计划确认（`confirmAiRun`）、语音处理 Run、每日成长总结 Run。
   - `sync.ts`：离线变更高并发命令队列（`SyncCommandBatch`）、家庭与用户级增量变更 Feed（`FamilyChanges`、`UserChanges`）、可重复读一致性快照（`SyncSnapshot`）。
   - `attachments.ts`：私有 S3 对象上传预授权、文件校验与完成标记（`completeAttachment`）、受鉴权流式下载与删除。
   - `devices.ts`：APNs 与 Web Push 设备注册/解绑、站内通知列表与幂等已读标记。
   - `nutrition.ts`：配方奶产品库（`FormulaProduct`，冲调比例/归档）、食材库、分月龄辅食指南、宝宝辅食计划。
   - `knowledge.ts`：发育里程碑标准、月龄亲子活动建议、发育预警红旗指标、育儿书单状态。
   - `appConfig.ts`：服务运行时配置、时区与功能开关。
   - `mcp.ts`：RFC8414 OAuth 2.1 授权服务器元数据、受保护资源元数据、OAuth 令牌兑换与撤销、MCP JSON-RPC 2.0 端点。
   - `routes.ts`：统一登记全量路由元数据，共 **84 个路径，119 个操作端点**。全部具备全局唯一的 `operationId` 与显式 `x-implementation-status` 状态标记（如 `READY`、`READY_TEST_SAMPLE`、`PLANNED_SH03`、`PLANNED_SH04F` 等），无虚假成功桩。
2. **契约生成与校验管道**：
   - `scripts/contract-generator.mjs`：基于 Fastify 5 + `@fastify/swagger`，安全导出 OpenAPI 3.0.3；支持将 TypeBox 鉴别联合转换为主流 Swift 生成器推荐的 `oneOf` + `$ref` + `discriminator.mapping` 格式。
   - `scripts/generate-contracts.mjs`：生成 `contracts/openapi.json`。
   - `scripts/check-contracts.mjs`：内存动态比对源 schema 与磁盘文件，漂移时退出码 1 并阻止 CI。
   - `package.json`：用真实脚本替换了原 `scripts/not-ready.mjs` 占位。
3. **自动化测试套件**：
   - `packages/contracts/tests/contracts.test.ts`：覆盖输入校验、脱敏 Golden Fixture、超长限制（notes 1000字符）、非法枚举拒绝、operationId 唯一性检查、OpenAPI zero-diff 内存比对。
   - 经 Swift 6 `swift-openapi-generator` 1.13.1 实际编译测试，100% 成功解码包括判别联合体、Decimal 字符串、Nullable 字段和标准 400 `ApiErrorEnvelope` 响应。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `packages/contracts/src/common.ts` | 新增 | 核心 envelope、标量格式定义、FormatRegistry 与 Nullable 转换器 |
| `packages/contracts/src/health.ts` | 新增 | BOOT-02 健康探针契约独立化 |
| `packages/contracts/src/auth.ts` | 新增 | 身份、会话、刷新、恢复码与 BFF 会话交换契约 |
| `packages/contracts/src/user.ts` | 新增 | 用户个人信息、数据导出、注销契约 |
| `packages/contracts/src/family.ts` | 新增 | 家庭、成员、邀请码、宝宝档案多对多契约 |
| `packages/contracts/src/records.ts` | 新增 | 照护记录（喂养、睡眠、尿布、辅食、补充剂、时间线） |
| `packages/contracts/src/growth.ts` | 新增 | 体格发育测量、WHO百分位图表点、向后兼容模型 |
| `packages/contracts/src/medical.ts` | 新增 | 医疗报告、OCR Run、疫苗规范及接种记录 |
| `packages/contracts/src/ai.ts` | 新增 | AI 会话、长任务 Run、确认计划、语音 Run、日报 Run |
| `packages/contracts/src/sync.ts` | 新增 | 离线命令批量协议、增量 Feed、快照协议 |
| `packages/contracts/src/attachments.ts` | 新增 | 私有 S3 附件能力 |
| `packages/contracts/src/devices.ts` | 新增 | APNs / WebPush 设备绑定与通知 |
| `packages/contracts/src/nutrition.ts` | 新增 | 配方奶产品库、食材库、指南、周餐计划 |
| `packages/contracts/src/knowledge.ts` | 新增 | 里程碑、活动、预警征兆、书单 |
| `packages/contracts/src/appConfig.ts` | 新增 | 应用动态配置与特性开关 |
| `packages/contracts/src/mcp.ts` | 新增 | OAuth 2.1 发现协议与 MCP JSON-RPC 2.0 契约 |
| `packages/contracts/src/routes.ts` | 新增 | 84 个路径、119 个端点路由元数据与实现状态 |
| `packages/contracts/src/index.ts` | 修改 | 统一导出全部子模块契约 |
| `packages/contracts/tests/contracts.test.ts` | 新增 | 契约单元测试（7 项针对性测试） |
| `scripts/contract-generator.mjs` | 新增 | Fastify Swagger 3.0.3 规范生成与转换器 |
| `scripts/contract-generator.d.mts` | 新增 | 生成器类型声明，配合严格 ESM 构建 |
| `scripts/generate-contracts.mjs` | 新增 | 替换 not-ready 的生成入口脚本 |
| `scripts/check-contracts.mjs` | 新增 | 替换 not-ready 的无 diff 门禁校验脚本 |
| `contracts/openapi.json` | 新增 | 导出的标准 OpenAPI 3.0.3 规范文档 |
| `package.json` | 修改 | 更新 `backend:contracts:*` 脚本命令，添加 `@fastify/swagger` devDependency |
| `package-lock.json` | 修改 | 锁定 `@fastify/swagger` 及依赖包版本 |

---

## 3. 验证证据

### 3.1 契约生成 (`npm run backend:contracts:generate`)
```text
> growdesk-server@0.1.0 backend:contracts:generate
> node scripts/generate-contracts.mjs

Generating canonical OpenAPI 3.0.3 specification from @growdesk/contracts...
Successfully generated /Users/wangzhuo/Documents/GitHub/growdesk-server/contracts/openapi.json
- OpenAPI version: 3.0.3
- Path count: 84
- Operation count: 119
- Schema component count: 43
Exit Code: 0
```

### 3.2 契约一致性校验 (`npm run backend:contracts:check`)
```text
> growdesk-server@0.1.0 backend:contracts:check
> node scripts/check-contracts.mjs

Checking canonical OpenAPI specification consistency...
Contract check passed: /Users/wangzhuo/Documents/GitHub/growdesk-server/contracts/openapi.json is perfectly in sync (84 paths, 119 operations).
Exit Code: 0
```

### 3.3 TypeScript 构建与类型检查
```text
npm run backend:build
Exit Code: 0

npm run backend:typecheck
> growdesk-server@0.1.0 backend:typecheck
> tsc -p tsconfig.backend.json --noEmit
Exit Code: 0
```

### 3.4 架构分层与代码规范检查 (`npm run backend:lint`)
```text
> growdesk-server@0.1.0 backend:lint
> eslint . && node scripts/check-architecture.mjs

Architecture check passed (46 TypeScript source files).
Exit Code: 0
```
- 无任何 `any` 关键字逃逸；
- `packages/contracts` 未引用任何数据库驱动、Fastify 或内部受限层。

### 3.5 单元测试套件 (`npm run backend:test:unit`)
```text
▶ GrowDesk Contracts Test Suite
  ✔ ApiErrorEnvelope schema validates standard error payload (0.641334ms)
  ✔ Feeding record creation payload validates correct input and rejects malformed fields (0.36025ms)
  ✔ Sleep record creation payload validates correct input (0.105583ms)
  ✔ Growth measurement schema enforces decimal strings (0.133125ms)
  ✔ Sync command batch schema validates offline mutations structure (0.275417ms)
  ✔ ROUTE_DEFINITIONS has unique operationIds and explicit status markings (0.227792ms)
  ✔ Canonical OpenAPI 3.0.3 spec matches contracts/openapi.json with zero diff (931.11025ms)
✔ GrowDesk Contracts Test Suite (933.485458ms)
...
ℹ tests 81
ℹ suites 1
ℹ pass 81
ℹ fail 0
Exit Code: 0
```

### 3.6 Swift 6 契约客户端编译与兼容性测试
- 命令：`swift test --disable-automatic-resolution`（在 `scratch/boot01/swift-openapi-check`）
```text
Swift OpenAPI Generator is running with the following configuration:
- OpenAPI document path: .../openapi.json
- Generator modes: types, client
- Output directory: .../destination/OpenAPIGenerator/GeneratedSources
[25 / 25] SwiftOpenAPICheck-product
Build complete! (5.10 sec)
􀟈  Suite "Swift OpenAPI Generator Contract Compatibility Tests" started.
􀟈  Test "TimelineEvent discriminated union decodes feeding and diaper events" started.
􀟈  Test "Standard ApiError envelope decodes correctly" started.
􀟈  Test "GrowthRecord decodes correctly with null optional field and decimal strings" started.
􀟈  Test "API response envelope for timeline event decodes directly into Components.Schemas.TimelineEvent" started.
􀟈  Test "Fastify 400 validation error response decodes into Components.Schemas.ApiErrorEnvelope matching createTimelineEvent 400 response" started.
􁁛  Test "API response envelope for timeline event decodes directly into Components.Schemas.TimelineEvent" passed after 0.001 seconds.
􁁛  Test "Standard ApiError envelope decodes correctly" passed after 0.001 seconds.
􁁛  Test "GrowthRecord decodes correctly with null optional field and decimal strings" passed after 0.001 seconds.
􁁛  Test "Fastify 400 validation error response decodes into Components.Schemas.ApiErrorEnvelope matching createTimelineEvent 400 response" passed after 0.001 seconds.
􁁛  Test "TimelineEvent discriminated union decodes feeding and diaper events" passed after 0.001 seconds.
􁁛  Suite "Swift OpenAPI Generator Contract Compatibility Tests" passed after 0.001 seconds.
􁁛  Test run with 5 tests in 1 suite passed after 0.001 seconds.
Exit Code: 0
```

---

## 4. 契约度量指标总结

- **OpenAPI 规范版本**：`3.0.3`
- **总路径数 (Paths)**：84
- **总端点操作数 (Operations)**：119（所有 `operationId` 均为驼峰命名且全局唯一）
- **复用组件 Schema 数**：43
- **实现状态标记覆盖率**：100%（所有路由均标有明确 `x-implementation-status`）
- **零漂移保障**：`scripts/check-contracts.mjs` 保证 CI 构建时文件无漂移

---

## 5. 验收结论与后续准备

- **本任务状态**：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`（实现与验证全部通过，等待独立 review）
- **未提交污点防护**：现有 `deploy/Migration.Dockerfile`、`evidence/tasks/LEGACY_IMPORT/*`、`scripts/legacy-import/*` 完全保留未动。
- **允许进入下一阶段**：`SH-02A/B`（PostgreSQL 18 实体模型扩展、Prisma 迁移脚本与 Principal-Scoped UnitOfWork 基础）。
