# SH-09 任务独立架构与代码审计复查报告 (Review Report)

> **任务编号**：SH-09 (BE-06 后端同步协议与本地状态机 / Local-First Sync Protocol & State Machine)  
> **审查结论**：`ACCEPTED` (验收通过)  
> **审查角色**：独立系统架构与代码审计 Review Agent (非实现者)  
> **审查日期**：2026-09-13  
> **审查基线与提交**：  
> - `growdesk-server`：基线 `c9f2ef2`，交付提交 `7c549db`  
> - `baby_panel_for_cecilia`：基线 `afae355`，交付提交 `80bbd83`  
> - `growdesk-ios`：基线 `96aa000` (只读参考，无新增提交)  
> **协议与规范权威**：  
> 1. `docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md`（第 14 节 SH-09 任务卡与第 19 节报告格式标准）  
> 2. `docs/plan/implementation/02_BACKEND_CONTRACTS.md`（§4 离线状态机与 §5 增量同步协议）、`07_LOCAL_FIRST_OPTIONAL_SYNC.md`、`06_AGENT_EXECUTION_PLAYBOOK.md` (BE-06)  
> 3. 三仓库根目录 `AGENTS.md` (测试数据与环境硬隔离规范、生产数据库 prod.db 零接触、防串号与权限规范)  

---

## 1. 审查基线与三仓库物理隔离复核

### 1.1 三仓库物理与状态隔离复核结果

| 仓库路径 | 当前分支 | 基线提交 SHA | 交付提交 SHA | 工作区状态 (Git Status) | 审计结论 |
|---|---|---|---|---|---|
| **`growdesk-server`** | `codex/backend-storage-foundation` | `c9f2ef2` | `7c549db` | Dirty (6 个历史未提交文件严格隔离原样保留) | **通过**。交付提交仅包含同步协议核心代码、TypeBox 契约就绪声明与集成测试；6 个历史文件零污染、零提交。 |
| **`baby_panel_for_cecilia`** | `main` | `afae355` | `80bbd83` | Clean (Ahead 29 of origin) | **通过**。提交仅更新长程推进进度表 `evidence/long-run/PROGRESS.md`，工作区完全干净。 |
| **`growdesk-ios`** | `codex/local-storage-policy` | `96aa000` | *(无提交)* | Dirty (历史未提交文件严格原样保留) | **通过**。HEAD 保持 `96aa000`，未被触碰或混入。 |

### 1.2 关键历史未提交文件隔离验证
- **`growdesk-server` 6 个历史未提交文件**：
  1. `deploy/Migration.Dockerfile` (经 `git diff` 复核，仅包含既有 apt-get 依赖，未引入任何新修改)
  2. `evidence/tasks/LEGACY_IMPORT/host-after.json` (未跟踪，原样保留)
  3. `evidence/tasks/LEGACY_IMPORT/remote-migration.txt` (未跟踪，原样保留)
  4. `evidence/tasks/LEGACY_IMPORT/target-verification.json` (未跟踪，原样保留)
  5. `scripts/legacy-import/ios_backup.py` (未跟踪，原样保留)
  6. `scripts/legacy-import/test_ios_backup.py` (未跟踪，原样保留)
  - **核验结论**：经 `git status` 与 `git diff` 验证，上述 6 个文件完好无损，零篡改、零混入、零提交。
- **生产数据库 `prod.db` (权限 600) 与 3088 端口安全防护**：
  - 经 `lsof -i :3088` 检查，3088 端口服务未受任何干扰；
  - 经目录检索，工作区内仅存在 `dev_test.db`，生产库 `prod.db` 保持物理隔离，零连接、零触碰。测试全部运行于隔离运行器（随机高端口 PostgreSQL 18 + Redis 8）。

---

## 2. 同步协议核心实现逐项复查核验

### 2.1 离线突变指令批量摄入 (`POST /api/v1/sync/commands`) —— **ACCEPTED**

复查审计了 `apps/api/src/services/sync-service.ts` 与 `apps/api/src/routes/sync-routes.ts`：

1. **批次容量与事务独立性**：
   - 契约约束：`SyncCommandBatchRequestSchema` 中声明 `commands: Type.Array(SyncCommandSchema, { minItems: 1, maxItems: 50 })`，严格限制单批次最大 50 条指令；
   - 独立事务隔离：在 `executeSyncCommands` 中使用 `for (const cmd of commands)` 循环逐条调用 `executeSingleCommand`，每条指令在独立的工作单元事务中执行，单个命令失败（如校验错误或并发冲突）不阻断整批执行，返回标准结果包络 `{ data: { results: [...] } }`。
2. **批内实体依赖排查与因果序保障**：
   - 在处理任何指令前，首先扫描批次内所有 `cmd.entityId`：若在同一批次中发现重复 `entityId`，直接抛出 `statusCode: 422, code: "BATCH_DEPENDENCY_UNRESOLVED"`，整批拒绝。杜绝客户端在一个 wire batch 中依赖数组顺序乱序提交父子更新（`SYNC-03` 测试验证）。
3. **幂等重放与游标单调缓存**：
   - 在 `packages/database/src/unit-of-work.ts` 中增强了 `executeFamilyUnitOfWork`：
     - 在写入 `IdempotencyReceipt` 时，将其 `resultSummary` 扩充记录为 `{ summary, familyCursor, version }`；
     - 遇到已执行相同 `commandId` 且 hash 匹配的重放请求时，从 `existingReceipt.resultSummary` 准确提取历史 `version` 与 `familyCursor`，返回 `status: "replayed"`；
     - 不重复分配游标，不重复向 `family_changes` 写入数据行（`SYNC-02` 测试验证）。
4. **乐观并发控制 (OCC)**：
   - 指令执行严格校验 `baseVersion`。当检测到版本分叉时，底层仓储抛出 `ConcurrencyConflictError`；
   - `SyncService` 捕获该异常并通过 `getCurrentEntityVersion` 读取当前实体的真实版本号，返回 `status: "conflict"`，并在 `conflict` 字段中携带 `currentVersion`、`currentEntity` 与原因，供客户端执行冲突解决（`SYNC-04` 测试验证）。
5. **6 大照护领域原子写与时间线投影**：
   - 覆盖全部 6 个照护领域：`feeding`, `diaper`, `sleep`, `foodLog`, `supplementRecord`, `growthMeasurement`；
   - 支持 `create`, `update`, `delete` 操作；
   - 在 `unit-of-work.ts` 中统一将 `command.babyId` 注入 `FamilyChange.payload`，原子更新 `TimelineEntry`、`FamilySyncState.cursor` 与变更日志（`SYNC-01` 测试验证）。

---

### 2.2 增量变更流与 HMAC SHA-256 签名游标 —— **ACCEPTED**

复查审计了 `packages/database/src/sync-cursor.ts` 与增量查询端点：

1. **HMAC SHA-256 签名不透明游标 (`encodeSyncCursor` / `decodeSyncCursor`)**：
   - 游标载荷结构：`{ scope, scopeId, epoch, position, highWater, mode, schemaVersion }`；
   - 编码格式：`${base64url(JSON)}.${hmacSha256Hex}`；
   - 解码与鉴权：采用 `crypto.timingSafeEqual` 防范时序攻击；
   - 跨作用域与篡改防护：解码时强校验 `expectedScope` 与 `expectedScopeId`，游标签名被篡改或跨家庭呈递时，立即抛出 `InvalidSyncCursorError` 并返回 HTTP 400 `INVALID_SYNC_CURSOR`（`SYNC-07` 测试验证）。
2. **高水位线采样与分页/尾部发现平滑切换**：
   - 游标分页区间：严格限定在开闭区间 `(position, highWater]`；
   - `mode: "page"`：固定 `highWater`，按 `limit` 分页拉取，`nextCursor` 推进至当前页末尾；
   - `mode: "tail"`：当本轮数据已全部消费完毕（`!hasMore`），`nextMode` 平滑切换为 `"tail"`，`nextPosition` 置为当前 `highWater`；客户端以 tail 游标进行长轮询时，服务端动态采样最新的 `syncState.cursor` 作为新水位，从而精准发现后续新变更（`SYNC-05` 测试验证）。
3. **分代重置守卫 (Epoch Mismatch Guard)**：
   - 校验客户端游标中的 `epoch` 与服务端当前 `FamilySyncState.epoch`（或 `UserSyncState.epoch`）；
   - 若分代不一致，直接抛出 `SyncResetRequiredError` 并返回 HTTP 410 `SYNC_RESET_REQUIRED`，驱动客户端执行全量重置（`SYNC-06` 测试验证）。
4. **`BabyMember` 逐宝宝鉴权隔离 (防元数据泄漏)**：
   - 在家庭变更流 `getFamilyChanges` 中，不仅校验当前用户是否为该家庭活跃成员，更进一步在投影时查询请求用户在该家庭中具有活跃关系的 `babyId` 集合；
   - 过滤逻辑：变更流只保留该用户具有访问权的宝宝变更；对于未授权或已撤权的宝宝变更，直接在流中剔除，杜绝权限撤销后的任何数据与元数据泄漏（`SYNC-08` 测试验证）。
5. **用户增量变更流 (`GET /api/v1/sync/me/changes`)**：
   - 基于 `user_changes` 表与 `UserSyncState`，机制与家庭流完全同构（`SYNC-09` 测试验证）。

---

### 2.3 全量引导快照协议 (`POST & GET /api/v1/sync/families/:id/snapshots`) —— **ACCEPTED**

1. **快照排队与 202 Accepted**：
   - `POST /api/v1/sync/families/:id/snapshots`：验证家庭成员权限，创建 `SyncSnapshot`（初始状态 `queued`）并在同一流程中向 `TaskExecution` 表排队 `sync_snapshot_family` 任务，端点立即返回 202 Accepted 及 `snapshotId`；
2. **Worker 引擎内置处理器**：
   - `apps/worker/src/worker-engine.ts` 中注册了内置 `sync_snapshot_family` processor，处理后更新快照状态为 `ready`，并将 `page_count` 置为 1；
3. **快照清单检索**：
   - `GET /api/v1/sync/families/:id/snapshots/:snapshotId`：返回快照元数据、当前状态（queued / processing / ready / failed）、分卷数及过期时间（`SYNC-10` 测试验证）。

---

### 2.4 契约就绪与 OpenAPI 严格对齐 —— **ACCEPTED**

1. **路由状态标记**：
   - `packages/contracts/src/routes.ts` 中 5 个同步操作全部由 `PLANNED_SH09` 更新为 `READY`：
     - `executeSyncCommands`
     - `getFamilyChanges`
     - `getUserChanges`
     - `createFamilySnapshot`
     - `getFamilySnapshot`
2. **Canonical OpenAPI 规范同步**：
   - 运行 `npm run backend:contracts:check`：
     ```text
     Checking canonical OpenAPI specification consistency...
     Contract check passed: contracts/openapi.json is perfectly in sync (86 paths, 123 operations).
     ```
   - 86 paths、123 operations 保持 0 diff 严格同步。

---

## 3. 全量测试运行与验证证据

### 3.1 `growdesk-server` 后端验证证据

| 验证项目 | 执行命令 | 结果 | 耗时/指标 |
|---|---|---|---|
| **TypeScript 类型检查** | `npm run backend:typecheck` | **PASS (0 errors)** | ~2.5s |
| **ESLint 与架构门禁** | `npm run backend:lint` | **PASS (0 errors)** | 102 个 TypeScript 源码文件全量通过 |
| **契约零 Diff 校验** | `npm run backend:contracts:check` | **PASS** | 86 paths, 123 operations 完美同步 |
| **单元测试套件** | `npm run backend:test:unit` | **PASS (84/84 通过)** | 1125.53ms，0 failed |
| **PG18/Redis8 隔离集成测试** | `python3 scripts/test-integration.py` | **PASS (195/195 通过)** | 9388.04ms，0 failed |

**SH-09 专项集成测试 10 项全部通过明细**：
```text
▶ SH-09: Local-First Sync Protocol & State Machine Suite
  ✔ 00. Setup: Register users, create family and baby memberships (1935.02ms)
  ✔ SYNC-01: Batch command execution creates multi-domain records and advances cursor (59.02ms)
  ✔ SYNC-02: Command idempotency replay returns cached cursor and version (6.78ms)
  ✔ SYNC-03: Intra-batch duplicate entityId is rejected with 422 BATCH_DEPENDENCY_UNRESOLVED (2.12ms)
  ✔ SYNC-04: Optimistic concurrency conflict returns status: conflict with currentVersion (6.66ms)
  ✔ SYNC-05: Family incremental change feed pagination and mode transition (30.40ms)
  ✔ SYNC-06: Epoch mismatch returns 410 SYNC_RESET_REQUIRED (2.41ms)
  ✔ SYNC-07: Cursor tampering and cross-family cursor throws 400 INVALID_SYNC_CURSOR (9.77ms)
  ✔ SYNC-08: BabyMember revocation filters out baby changes from feed (15.36ms)
  ✔ SYNC-09: User changes feed pagination (3.66ms)
  ✔ SYNC-10: Bootstrap snapshot queueing and background processing (16.05ms)
✔ SH-09: Local-First Sync Protocol & State Machine Suite (2416.65ms)
```

### 3.2 `baby_panel_for_cecilia` 兼容性与无回归验证证据

| 验证项目 | 执行命令 | 结果 | 耗时/指标 |
|---|---|---|---|
| **全量自动化测试** | `npm test` | **PASS (185/185 通过)** | 182 项单元测试 + 3 项 AI 测试全绿 |
| **生产写入口守卫** | `npm run check:writers` | **PASS** | 14 个业务路由与 MCP 入口全部受 BFF 保护 |

---

## 4. 任务报告与长程进度表核查

1. **`evidence/tasks/SH-09/REPORT.md` (growdesk-server)**：
   - 严格遵循第 19 节任务报告格式规范；
   - 准确声明基线 `c9f2ef2` 与交付提交 `7c549db`；
   - 详尽列出 13 个变更文件清单、技术实现细节与测试证据。
2. **`evidence/long-run/PROGRESS.md` (baby_panel_for_cecilia)**：
   - 状态已更新为 `SH-09 完成 -> 进入 L3 (SH-10: 安全生产配置、结构化审计日志与可观测性)`；
   - 表格与条目已准确记录 SH-09 交付状态与下一任务目标。

---

## 5. 审查结论与下一任务放行

### 5.1 最终审查结论
**`ACCEPTED` (验收通过)**

SH-09 任务交付的代码设计精密、架构清晰，完全满足 `09_WEB_IOS_SHARED_BACKEND.md` 第 14 节、`02_BACKEND_CONTRACTS.md` 第 4/5 节及 `07_LOCAL_FIRST_OPTIONAL_SYNC.md` 的所有硬性安全与协议要求。

### 5.2 明确允许领取的下一任务
- **任务编号**：**`SH-10: 安全生产配置、结构化审计日志与可观测性 (Production Readiness, Audit Logging & Observability)`**
- **工作目录**：`/Users/wangzhuo/Documents/GitHub/growdesk-server`
- **主要范围**：
  1. 生产环境变量与密钥分级校验解析器；
  2. 全链路请求追踪 (`requestId`)、安全脱敏结构化审计日志；
  3. 增强型健康检查探针与可观测性指标。

### 5.3 下一任务前置约束
1. **三仓库物理与状态隔离**：继续严格隔离 `baby_panel_for_cecilia`、`growdesk-server`、`growdesk-ios`；
2. **历史未提交文件保护**：`growdesk-server` 中的 6 个历史脏文件（`deploy/Migration.Dockerfile`、`evidence/tasks/LEGACY_IMPORT/*`、`scripts/legacy-import/*`）必须保持原状，严禁混入提交；
3. **生产环境与数据零接触**：严禁连接 `prod.db`、严禁干扰 3088 端口服务与 230 生产配置；所有测试必须严格使用 `test_*` 动态隔离租户。
