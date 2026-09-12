# 任务执行报告：SH-02B UnitOfWork 与事务底座

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`2cd4efb2d3527b140788ee5c0211a1a6b0c793ba` (SH-02A)  
> 依赖前置：`SH-02A` (已完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 7 节（SH-02）、第 70 行拆分规则及 `02_BACKEND_CONTRACTS.md` 第 4.3 节规范，实施 **SH-02B UnitOfWork 与事务底座**：
1. **错误体系定义 (`packages/database/src/errors.ts`)**：
   - 强类型错误：`DatabaseError`、`IdempotencyKeyReusedError` (409)、`ConcurrencyConflictError` (409)、`RecordNotFoundError` (404)、`ScopeMismatchError` (400)、`FamilyAccessDeniedError` (403)、`BabyAccessDeniedError` (403)。
2. **连接与上下文管理 (`packages/database/src/client.ts`)**：
   - `DatabaseContext` 导出，提供 `PrismaClient` 与原生 `pg.Pool`，支持安全关闭与生命周期挂钩。
3. **标准 8 步事务算法 (`packages/database/src/unit-of-work.ts`)**：
   - 遵循 `02_BACKEND_CONTRACTS.md` 第 4.3 节严格锁序：
     1. **幂等前置检查**：查询 `idempotency_receipts`。若哈希完全相同且已完成，直接返回历史响应（`replayed: true`）；若哈希不同，立即抛出 409 `IDEMPOTENCY_KEY_REUSED`。
     2. **锁序保证**：`SELECT cursor FROM family_sync_states WHERE family_id = ... FOR UPDATE`。先拿家庭级排他行锁，保证同一家庭内游标递增和写操作严格串行化，从物理上杜绝并发死锁与游标乱序。
     3. **带锁权限二次校验**：在持有行锁的事务上下文内，重读并核验 `FamilyMember`（非 viewer 且 active）与 `BabyMember`（必须存在且角色为 admin 或 member），禁止越权写。
     4. **乐观锁版本核验**：执行 `baseVersion` 乐观并发控制检查。
     5. **业务回调执行**：在事务内执行调用方的业务持久化函数。
     6. **时间线同步投影**：在同事务内插入或更新 `timeline_entries` 投影，保证业务记录与时间线严格一致。
     7. **单调游标递增与变更记录**：游标加 1，写回 `family_sync_states`，并写入 `family_changes` 变更 feed。
     8. **幂等收据与任务 Outbox 持久化**：写入 `idempotency_receipts` 并可选写入 `task_outbox`，保证消息发件箱与事务原子提交。
4. **仓储层与时间线仓储 (`packages/database/src/feeding-repository.ts`, `timeline-repository.ts`)**：
   - `FeedingRepository`：通过 `executeFamilyUnitOfWork` 包装喂养记录的创建、更新与软删除。
   - `TimelineRepository`：提供基于 `[occurredAt DESC, id DESC]` 的高效 keyset 分页查询。
5. **真实 PostgreSQL 18 集成测试验证 (`tests/integration/unit-of-work.test.ts`)**：
   - 覆盖全部 7 项标准测试用例：
     - `B-01`：幂等重放返回缓存结果，游标不递增。
     - `B-02`：幂等 Key 重用但负载不同抛出 409 `IDEMPOTENCY_KEY_REUSED`。
     - `B-04`：并发冲突在 `baseVersion` 不匹配时准确检出并返回 409。
     - `B-05`：事务原子性，业务回调抛错时完整回滚（业务行、游标、变更、收据均不落库）。
     - `B-06`：无 `BabyMember` 行或仅具备 viewer 权限的用户禁止写操作（返回 403）。
     - `B-07`：高并发写入在 `FamilySyncState` 行锁下安全串行化，分配连续递增的唯一游标。
     - `B-08`：时间线投影随业务记录原子更新，并支持 keyset 分页。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `packages/database/src/errors.ts` | 新增 | 强类型数据库与业务错误（幂等重用、并发冲突、权限越界等） |
| `packages/database/src/client.ts` | 新增 | `DatabaseContext` 工厂与生命周期管理 |
| `packages/database/src/unit-of-work.ts` | 新增 | 严格遵循 8 步规范的 `executeFamilyUnitOfWork` 核心实现 |
| `packages/database/src/feeding-repository.ts` | 新增 | 喂养记录标准领域仓储 |
| `packages/database/src/timeline-repository.ts` | 新增 | 时间线 keyset 分页与投影仓储 |
| `packages/database/src/index.ts` | 修改 | 统一导出 UnitOfWork、Repositories、Errors 及 DatabaseContext |
| `tests/integration/unit-of-work.test.ts` | 新增 | 针对真实 PG18 的 UnitOfWork 完整并发与事务测试套件 |
| `scripts/test-integration.py` | 修改 | 集成测试运行器按序执行 unit-of-work 集成测试 |
| `evidence/tasks/SH-02B/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层与类型检查
```bash
npm run backend:lint
# Output:
# Architecture check passed (51 TypeScript source files).

npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)
```

### 3.2 单元测试套件
```bash
npm run backend:test:unit
# Output:
# ℹ tests 81
# ℹ suites 1
# ℹ pass 81
# ℹ fail 0
# ℹ duration_ms 1448.056042
```

### 3.3 真实 PG18 集成测试（17 项全部通过）
```bash
python3 scripts/test-integration.py
# Output:
# Legacy import integration PASS: atomic rollback, same batch retry, changed batch refusal, multi-family composite FK, user deletion preserves shared baby, archive private.
# ✔ SH-02A: foundation migration applies cleanly and establishes all core tables (53.180084ms)
# ✔ SH-02A: composite foreign keys prevent cross-family baby reference (14.524375ms)
# ✔ SH-02A: check constraints reject invalid values and enforce version/cursor non-negative (12.200416ms)
# ✔ SH-02A: user deletion cascades credentials/sessions but preserves shared baby (45.7125ms)
# ✔ SH-02A: idempotency receipt primary key enforces actor/scope/command uniqueness (15.816417ms)
# ✔ SH-02A: index query plan confirms timeline index usage (21.769208ms)
# ✔ isolated PostgreSQL enforces role, ownership, constraints and rollback (28.939709ms)
# ✔ isolated authenticated Redis has working expiry and atomic NX writes (11.4765ms)
# ✔ foundation HTTP readiness checks owned PostgreSQL and Redis with real drivers (209.825917ms)
# ▶ SH-02B: UnitOfWork full transaction and concurrency suite
#   ✔ B-01: Idempotent replay returns cached result without re-executing (133.349209ms)
#   ✔ B-02: Key reuse with different payload throws 409 IDEMPOTENCY_KEY_REUSED (3.532583ms)
#   ✔ B-04: Concurrency conflict detected on baseVersion mismatch (38.789042ms)
#   ✔ B-05: Transaction atomicity rolls back all changes on callback error (34.571041ms)
#   ✔ B-06: Baby access denied if BabyMember row is missing or viewer (9.038709ms)
#   ✔ B-07: Concurrent commands serialize under FamilySyncState row lock (62.709083ms)
#   ✔ B-08: Timeline projection is maintained atomically with keyset pagination (19.692083ms)
# ✔ SH-02B: UnitOfWork full transaction and concurrency suite (347.685834ms)
# ℹ tests 17
# ℹ suites 0
# ℹ pass 17
# ℹ fail 0
# ℹ duration_ms 2589.37825
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

### 3.4 证据形态校验
```bash
npm run backend:evidence:check -- --task SH-02B
# Output:
# Evidence shape check passed for SH-02B (1 files).
```

---

## 4. 下一步工作建议

按 `09_WEB_IOS_SHARED_BACKEND.md` 路线图推进 **SH-03: 账号、会话与宝宝授权 (Auth, Session & BabyMember Authorization)**。
根据拆分规则依次实施：
- **SH-03A**：登录与设备会话 (`DeviceSession`, bcrypt 密码校验与透明升级, JWT 签发 `aud: .../mcp`, Fastify auth 插件与统一 `UserPrincipal` 解析)
- **SH-03B**：刷新令牌轮换与撤销 (`RefreshCredential`, 原子轮换与重放检测)
- **SH-03C**：家庭与宝宝逐级授权 (`BabyMember` 邀请接受、主动退出、最后活跃管理员保护)
- **SH-03D**：密码修改与恢复码 (`RecoveryCode` 10组 128-bit 批量签发与重置)
