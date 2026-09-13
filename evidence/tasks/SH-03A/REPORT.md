# 任务执行报告：SH-03A 登录与设备会话

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`ae97fccb2f6ef5391d8e1329eeeb2423ef6f6f96` (SH-02B)  
> 依赖前置：`SH-02A`, `SH-02B` (已完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 8 节（SH-03）、第 70 行拆分规则及 `02_BACKEND_CONTRACTS.md` 第 3.1-3.3 节规范，实施 **SH-03A 登录与设备会话**：
1. **密码哈希与旧版平滑升级 (`apps/api/src/auth/password.ts`)**：
   - 支持旧版 bcrypt 哈希（`$2a$`, `$2b$`, `$2y$`）安全比对；
   - 登录成功时若检测到旧哈希或低成本轮数，触发透明哈希升级（提升至 cost 12），更新数据库 `password_hash` 与 `password_hash_version`，不强制用户重置密码。
2. **访问令牌与刷新凭证管理 (`apps/api/src/auth/tokens.ts`)**：
   - 遵循 `02_BACKEND_CONTRACTS.md` 第 3.2 节：
     - JWT 采用 HS256，固定 `iss: "growdesk-api"`、`aud: "baby-panel-api"`、`typ: "at+jwt"`，严格绑定 `sub: userId`、`sid: sessionId`、`jti`，默认 10 分钟生命周期；
     - 验证时强制检查 `iss`、`aud`、`typ` 与 `exp`；
     - Refresh Token 生成 32 字节高熵随机数，存储在 PostgreSQL 18 的仅为 SHA-256 摘要（`token_hash`），绝不落盘明文。
3. **设备会话与 Principal 动态重验 (`apps/api/src/auth/session-service.ts`)**：
   - 每次登录/注册创建 `DeviceSession`（30 天绝对有效）与初始 `RefreshCredential`（7 天空闲过期）；
   - 支持推断平台类型（`ios`, `web`, `macos`, `android`, `unknown`），遵守 `device_sessions_platform_check` 约束；
   - 每次鉴权请求直接从数据库重读 `DeviceSession`、`User`、`FamilyMember` 与 `BabyMember`，只要 session 被撤销或 user 被删除即刻生效，不依赖长期正向缓存。
4. **Fastify 鉴权插件与路由实现 (`apps/api/src/plugins/auth-plugin.ts`, `apps/api/src/routes/auth-routes.ts`)**：
   - `authPlugin` 提供 `fastify.authenticate` 钩子，解析 Bearer Token，动态挂载强类型 `request.principal: UserPrincipal`；
   - 挂载路由：
     - `POST /api/v1/auth/register` (201)：原子创建用户、默认家庭、admin 成员关系、同步状态、设备会话与凭据；
     - `POST /api/v1/auth/login` (200)：凭据验证与透明哈希升级，签发独立会话；
     - `POST /api/v1/auth/logout` (200)：撤销当前会话与关联刷新凭证；
     - `GET /api/v1/auth/sessions` (200)：列出当前用户所有活跃会话；
     - `DELETE /api/v1/auth/sessions/:id` (200)：按 ID 显式撤销指定会话；
     - `GET /api/v1/me` (200)：获取当前用户详情；
   - 全局统一错误处理器：严格输出标准 `ApiErrorEnvelope`（`error: { code, message, requestId }`）。
5. **单元测试与真实 PostgreSQL 18 集成测试验证**：
   - 单元测试 (`apps/api/tests/auth.test.ts`)：密码哈希/比对/legacy升级判断、JWT 签发/验签/过期拒绝/错误 audience 拒绝/篡改拒绝、刷新令牌 SHA-256 确定性。
   - 真实 PG18 集成测试 (`tests/integration/auth.test.ts`)：覆盖 A-01 至 A-09 全部 9 项用例。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `apps/api/src/auth/password.ts` | 新增 | 密码哈希、bcrypt 校验与旧哈希升级逻辑 |
| `apps/api/src/auth/tokens.ts` | 新增 | JWT 访问令牌签发/验签与刷新令牌生成/摘要 |
| `apps/api/src/auth/session-service.ts` | 新增 | 设备会话生命周期与 UserPrincipal 动态解析 |
| `apps/api/src/plugins/auth-plugin.ts` | 新增 | Fastify 鉴权插件，装饰 request.principal |
| `apps/api/src/routes/auth-routes.ts` | 新增 | 注册、登录、登出、会话列表、会话撤销、当前用户接口 |
| `apps/api/src/app.ts` | 修改 | 装配 authPlugin、authRoutes 与标准 ApiErrorEnvelope 错误处理器 |
| `apps/api/tests/auth.test.ts` | 新增 | 密码与令牌核心单元测试套件 |
| `tests/integration/auth.test.ts` | 新增 | 针对真实 PG18 的 A-01 至 A-09 完整鉴权集成测试套件 |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 auth.test.ts |
| `package.json` | 修改 | 引入 bcryptjs 与 jose 依赖 |
| `evidence/tasks/SH-03A/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:lint
# Output:
# Architecture check passed (56 TypeScript source files).

npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)
```

### 3.2 单元测试套件（84 项全部通过）
```bash
npm run backend:test:unit
# Output:
# ✔ password hashing and verification (331.949875ms)
# ✔ access token signing and verification lifecycle (8.64275ms)
# ✔ refresh token generation and hashing (0.262084ms)
# ...
# ℹ tests 84
# ℹ suites 1
# ℹ pass 84
# ℹ fail 0
```

### 3.3 真实 PG18 集成测试（27 项全部通过）
```bash
python3 scripts/test-integration.py
# Output:
# Legacy import integration PASS: atomic rollback, same batch retry, changed batch refusal, multi-family composite FK, user deletion preserves shared baby, archive private.
# ▶ SH-03A: Authentication, DeviceSession, and Principal resolution suite
#   ✔ A-01: User registration creates user, default family, and initial session (256.465916ms)
#   ✔ A-02: Username duplicate registration rejected with 409 USERNAME_EXISTS (2.329125ms)
#   ✔ A-03: User login with valid credentials creates new session (78.36ms)
#   ✔ A-04: User login with invalid password rejected with 401 INVALID_CREDENTIALS (111.200792ms)
#   ✔ A-05: Legacy bcrypt hash transparently upgraded on successful login (336.562583ms)
#   ✔ A-06: Authenticated request resolves UserPrincipal and accesses /me (16.004625ms)
#   ✔ A-07: List active sessions returns all active DeviceSessions (16.438292ms)
#   ✔ A-08: Logout revokes session and subsequent requests fail with 401 (13.459084ms)
#   ✔ A-09: Explicit session revocation by ID terminates that session only (165.419041ms)
# ✔ SH-03A: Authentication, DeviceSession, and Principal resolution suite (1106.640958ms)
# ✔ SH-02A: foundation migration applies cleanly and establishes all core tables (60.815125ms)
# ✔ SH-02A: composite foreign keys prevent cross-family baby reference (26.26325ms)
# ✔ SH-02A: check constraints reject invalid values and enforce version/cursor non-negative (9.488375ms)
# ✔ SH-02A: user deletion cascades credentials/sessions but preserves shared baby (22.955708ms)
# ✔ SH-02A: idempotency receipt primary key enforces actor/scope/command uniqueness (15.351333ms)
# ✔ SH-02A: index query plan confirms timeline index usage (10.876167ms)
# ✔ isolated PostgreSQL enforces role, ownership, constraints and rollback (23.644041ms)
# ✔ isolated authenticated Redis has working expiry and atomic NX writes (10.611084ms)
# ✔ foundation HTTP readiness checks owned PostgreSQL and Redis with real drivers (269.624292ms)
# ▶ SH-02B: UnitOfWork full transaction and concurrency suite
#   ✔ B-01: Idempotent replay returns cached result without re-executing (142.611333ms)
#   ✔ B-02: Key reuse with different payload throws 409 IDEMPOTENCY_KEY_REUSED (3.469584ms)
#   ✔ B-04: Concurrency conflict detected on baseVersion mismatch (45.636875ms)
#   ✔ B-05: Transaction atomicity rolls back all changes on callback error (35.485417ms)
#   ✔ B-06: Baby access denied if BabyMember row is missing or viewer (10.093916ms)
#   ✔ B-07: Concurrent commands serialize under FamilySyncState row lock (63.202125ms)
#   ✔ B-08: Timeline projection is maintained atomically with keyset pagination (22.655834ms)
# ✔ SH-02B: UnitOfWork full transaction and concurrency suite (358.515667ms)
# ℹ tests 27
# ℹ suites 0
# ℹ pass 27
# ℹ fail 0
# ℹ duration_ms 2705.583333
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

### 3.4 证据形态校验
```bash
npm run backend:evidence:check -- --task SH-03A
# Output:
# Evidence shape check passed for SH-03A (1 files).
```

---

## 4. 下一步工作

推进 **SH-03B: 刷新令牌轮换与重放检测 (Refresh Token Rotation & Reuse Detection)**：
- 落实 `02_BACKEND_CONTRACTS.md` 第 3.2 节关于 `POST /api/v1/auth/refresh` 的原子单次使用轮换机制；
- 实现基于 `rotationId` 的 60 秒网络丢响应安全重发容错；
- 实施同一旧 Token 被非同 `rotationId` 复用时的级联撤销安全熔断（抛出 `REFRESH_REUSE_DETECTED` 并吊销整个 DeviceSession 树）；
- 编写双客户端并发 refresh、网络响应丢包重试与重用惩罚测试。
