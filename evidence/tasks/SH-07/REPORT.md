# 任务执行报告：SH-07 异步长任务与 AI/Worker/Scheduler 底座 (Durable Task Engine & AI Workers)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-13  
> 目标仓库：
>   - `/Users/wangzhuo/Documents/GitHub/growdesk-server` (分支 `codex/backend-storage-foundation`)
> 基线提交：`128b46d` (growdesk-server: SH-06), `cd733a4` (baby_panel_for_cecilia: SH-06)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A~D`、`SH-04F~TL`、`SH-05`、`SH-06` (已全部完成并验证)

---

## 1. 目标与架构概述

依据 `docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md` 第 12 节（SH-07 任务卡）、`02_BACKEND_CONTRACTS.md`、`03_DATABASE_MIGRATION.md` 以及 `06_AGENT_EXECUTION_PLAYBOOK.md` (BE-08A & BE-08B)：
本任务在 GrowDesk 共享后端建立统一的持久化长任务状态机底座（Durable Task Engine）、异步 Worker/Scheduler 调度中枢以及 AI 对话会话与长运行任务生命周期：

1. **持久化任务状态机与发件箱架构 (`TaskExecutionRepository` in `@growdesk/database`)**：
   - 任务核心表 `task_executions`：存储任务类型 (`kind`)、状态机 (`queued` -> `running` -> `awaiting_confirmation` / `succeeded` / `failed` / `cancelled`)、递增分代栅栏令牌 (`fenceToken: bigint`)、租约持有者 (`leaseOwner`) 与到期时间 (`leaseExpiresAt`)、心跳时间戳、取消请求标记及重试次数限制；
   - 事务性发件箱 `task_outbox`：在创建长任务或重试调度时，于同一数据库事务内原子写入 `task_outbox`，保证任务事件不丢失且只投递一次；
   - 租约竞争与原子栅栏 (`claimTask`)：基于 PostgreSQL 行级锁原子递增 `fence_token` 并分配带时限的 `lease_expires_at`，杜绝网络脑裂或过期工作进程；
   - 乐观栅栏校验与防幽灵写入：工作进程心跳、取消请求、状态流转（成功/失败/挂起）均严格比对 `fence_token`，若发现分代令牌不匹配直接抛出 409 `FencingTokenMismatchError` 并熔断；
   - 发件箱消费与优雅回收 (`claimNextOutboxBatch`, `reconcile`)：使用 `FOR UPDATE SKIP LOCKED` 高并发无锁竞争拉取就绪任务，调度协调器定时探测租约超期停滞任务（未超限则重新入队，超限则置为失败）。

2. **异步工作进程引擎 (`WorkerEngine` in `apps/worker`)**：
   - 基于定时心跳循环维持租约有效期，自动向数据库续租；
   - 优雅响应取消请求：心跳响应检测到 `cancelRequested` 时立即触发 `AbortSignal` 协调业务处理器安全中断；
   - 可插拔处理器注册表（支持 `mock_noop`、`ai_chat_run`、`voice_transcription`、`daily_summary_synthesis` 等）；
   - 异常安全熔断：遇到栅栏令牌失效时立即抛出致命错误并退出当前任务执行。

3. **调度协调中枢 (`SchedulerEngine` in `apps/scheduler`)**：
   - 批量发件箱消费：原子拉取 `dispatch_state = 'active'` 记录，投递消息队列/工作进程后将发件箱状态闭合为 `closed`；
   - 定时巡检与自愈补偿：发现租约超时且未达到最大重试次数的长任务自动写回发件箱重新排队，保障长任务高可用。

4. **AI 会话、消息与长任务生命周期 (`AiService` & `aiRoutes` in `apps/api`)**：
   - 数据模型与关系：`ai_sessions`, `ai_messages`, `ai_runs` (1:1 级联关联至 `task_executions`), `ai_run_events`, `daily_summaries`；
   - 11 个标准 REST 接口全部对齐 OpenAPI 契约：
     1. `POST /api/v1/ai/sessions` - 创建 AI 对话会话；
     2. `GET /api/v1/ai/sessions` - 分页检索当前用户会话列表；
     3. `GET /api/v1/ai/sessions/:id/messages` - 检索会话消息历史（按创建时间正序）；
     4. `POST /api/v1/ai/sessions/:id/runs` - 创建长运行 AI 任务（返回 202 Accepted，原子创建 TaskExecution、AiRun、用户消息与 Outbox）；
     5. `GET /api/v1/ai/runs/:id` - 查询 AI 运行实时状态与提议方案；
     6. `POST /api/v1/ai/runs/:id/confirm` - 人机回环确认采纳 AI 提议的操作方案（仅限 `awaiting_confirmation` 状态）；
     7. `POST /api/v1/ai/runs/:id/cancel` - 标记任务取消请求；
     8. `POST /api/v1/ai/runs/:id/retry` - 重试失败任务，重设状态为 `queued` 并增加 `attempt` 计数；
     9. `POST /api/v1/voice/runs` - 创建语音转录长任务；
     10. `POST /api/v1/babies/:babyId/daily-summaries/runs` - 创建每日综述合成长任务；
     11. `GET /api/v1/babies/:babyId/daily-summaries` - 检索宝宝每日智能综述归档。

---

## 2. 变更文件清单

### 后端服务 (`growdesk-server`)
| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 新增 `AiSession`, `AiChatMessage`, `AiRun`, `AiRunEvent`, `DailySummary` 模型及与 `User`, `Family`, `Baby`, `TaskExecution` 的关系 |
| `prisma/migrations/202609130011_tasks_and_ai/migration.sql` | 新增 | 创建 5 张核心表、索引、级联外键与 task_outbox 状态约束更新 |
| `packages/database/src/errors.ts` | 修改 | 新增 `FencingTokenMismatchError` (409) 错误类型 |
| `packages/database/src/task-repository.ts` | 新增 | 持久化长任务与发件箱仓储层（状态机、原子抢占、心跳续租、FOR UPDATE SKIP LOCKED 调度、停滞巡检自愈） |
| `packages/database/src/index.ts` | 修改 | 导出 `TaskExecutionRepository` 与 `Prisma` 命名空间 |
| `apps/worker/src/worker-engine.ts` | 新增 | Worker 工作进程引擎（心跳维持、取消信号传播、防脑裂栅栏保护） |
| `apps/worker/src/main.ts` | 修改 | Worker 服务入口装配与优雅退出 |
| `apps/scheduler/src/scheduler-engine.ts` | 新增 | Scheduler 发件箱分发器与周期性自愈补偿器 |
| `apps/scheduler/src/main.ts` | 修改 | Scheduler 服务入口装配与定时巡检 |
| `apps/api/src/services/ai-service.ts` | 新增 | AI 会话、消息、长任务生命周期服务（支持多租户隔离与 BabyMember 鉴权） |
| `apps/api/src/routes/ai-routes.ts` | 新增 | 11 个 AI / Voice / DailySummary REST 端点路由实现与契约校验 |
| `apps/api/src/app.ts` | 修改 | 注册 AI 相关 TypeBox Schema 并在 Fastify 中挂载 `aiRoutes` 插件 |
| `tests/integration/tasks.test.ts` | 新增 | Durable Task Engine、Worker 心跳与 Scheduler 调度集成测试套件 (10 项测试) |
| `tests/integration/ai-runs.test.ts` | 新增 | AI 会话、长运行任务生命周期、语音任务与每日综述集成测试套件 (10 项测试) |
| `tests/integration/foundation-migration.test.ts` | 修改 | 纳入迁移 `202609130011_tasks_and_ai` 数据库表结构断言 |
| `scripts/test-integration.py` | 修改 | 注册 `tasks.test.ts` 与 `ai-runs.test.ts` 入全量集成测试流 |

---

## 3. 验证命令与测试证据

### 3.1 架构、代码风格与类型检查
```bash
npm run backend:build
npm run backend:lint
npm run backend:typecheck
npm run backend:contracts:check
npm run backend:db:validate

# 检查输出：
# Architecture check passed (99 TypeScript source files).
# Contract check passed: contracts/openapi.json is perfectly in sync (86 paths, 123 operations).
# Database validation passed: 11 migrations verified.
```

### 3.2 单元与保护测试（84 项单元测试 + 18 项安全守卫测试全部通过）
```bash
npm run backend:test:guard
npm run backend:test:unit

# 检查输出：
# ℹ tests 18, ℹ pass 18, ℹ fail 0 (test:guard)
# ℹ tests 84, ℹ pass 84, ℹ fail 0 (test:unit)
```

### 3.3 真实 PostgreSQL 18 & Redis 隔离环境全量集成测试（183 项全部通过）
```bash
python3 scripts/test-integration.py

# 执行证据精简输出：
# ▶ SH-07: AI Sessions, Runs & Lifecycle suite
#   ✔ Setup: Register User A and User B, create families and babies
#   ✔ AI-01: Create AI session and list messages
#   ✔ AI-02: Create AI run returns 202 with unified TaskExecution and AiRun
#   ✔ AI-03: Get AI run status matches current state
#   ✔ AI-04: Confirming proposed actions requires awaiting_confirmation state
#   ✔ AI-05: Cancelling run updates task state
#   ✔ AI-06: Retrying failed run increments attempt and re-enqueues
#   ✔ AI-07: User B cannot access, read or confirm User A's AI run (404/403)
#   ✔ AI-08: Voice Run creation and Baby access validation
#   ✔ AI-09: Daily summary creation and listing with tenant boundary
# ✔ SH-07: AI Sessions, Runs & Lifecycle suite
#
# ▶ SH-07: Durable Task Engine & Worker/Scheduler Infrastructure suite
#   ✔ TASK-01: Outbox transactional creation alongside TaskExecution
#   ✔ TASK-02: Conditional claim atomically increments fence token and sets lease
#   ✔ TASK-03: Stale worker with outdated fence token is strictly rejected on completion
#   ✔ TASK-04: Periodic heartbeat extends lease correctly
#   ✔ TASK-05: Worker honors cancellation request and aborts gracefully
#   ✔ TASK-06: Outbox dispatcher claims with FOR UPDATE SKIP LOCKED and closes dispatched records
#   ✔ TASK-07: Scheduler reconciliation detects expired running tasks and re-enqueues within retry limit
#   ✔ TASK-08: Task reaching max attempts is transitioned to failed with error details
#   ✔ TASK-09: Park task puts execution in awaiting_confirmation and releases lease
# ✔ SH-07: Durable Task Engine & Worker/Scheduler Infrastructure suite
#
# ℹ tests 183
# ℹ suites 0
# ℹ pass 183
# ℹ fail 0
# ℹ cancelled 0
# ℹ skipped 0
# ℹ duration_ms 16548.236666
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
# Owned test processes stopped and private data directory removed.
```

---

## 4. 结论与下一步

SH-07（异步长任务与 AI/Worker/Scheduler 底座）在 `growdesk-server` 中已完整落地并经过端到端真实数据库与驱动严格验证，持久化发件箱、栅栏租约与 AI 全生命周期运行无误。

接下来进入下一阶段：
- **`SH-08: Web 剩余业务路由适配与 MCP 端点收口`**：
  - 梳理 Web 剩余业务路由（统计、图表、导出、提醒设置等）与 OpenAPI 契约的完整对接；
  - 收口 `/api/mcp` 端点与 stdio MCP 工具集在共享后端的映射与鉴权保障。
