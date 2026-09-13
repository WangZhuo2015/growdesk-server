# 任务执行报告：SH-03B 刷新令牌轮换与重放检测

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`923e1ebb8ecff4e1837ff4d3ff53fa89d4dd45a2` (SH-03A)  
> 依赖前置：`SH-03A` (已完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 8 节（SH-03）、第 70 行拆分规则及 `02_BACKEND_CONTRACTS.md` 第 3.2-3.3 节规范，实施 **SH-03B 刷新令牌轮换与重放检测**：
1. **严格遵循全局锁序的原子单次刷新 (`apps/api/src/auth/session-service.ts`)**：
   - 外部基于 SHA-256 `tokenHash` 快速定位目标凭据与用户 ID；
   - 事务内部强制遵守规范第 3.3 节全局锁序：`UserSyncState (按 userId 锁定) -> DeviceSession (按 sessionId 锁定) -> RefreshCredential (按 tokenHash 锁定)`；
   - 校验旧凭证状态（未撤销、未过期、所属会话未撤销且未绝对过期）；
   - 生成 256-bit 高熵随机 successor 凭证，计算 SHA-256 存入 `refresh_credentials`；
   - 旧凭据原子标记 `used_at = NOW()`，记录 `rotation_id` 与 `replaced_by_id = successorHash`；
   - 会话记录原子更新 `last_seen_at = NOW()`；
   - 签发新 JWT 访问令牌。
2. **60 秒网络丢响应重发容错与重放缓存 (`apps/api/src/auth/replay-store.ts`)**：
   - 当收到已标记 `used_at` 的旧 Token 时，对比其 `rotation_id`：
   - 若 `rotation_id` 完全一致且距使用时间在 60 秒内（处理客户端发信成功但因移动网络切换导致响应丢失的情景），直接从 `ReplayStore`（Redis / 内存安全降级）返回同一次已持久化的响应对象；
   - 严格保证重试不产生第二个不同的 successor，杜绝分叉。
3. **重用惩罚与会话级联熔断 (Reuse Detection)**：
   - 若收到已使用 Token，且 `rotation_id` 不同或已超过 60 秒容错窗口，判定为**Token 泄漏或重放攻击**；
   - 事务内先锁 `UserSyncState`，立即原子撤销整个 `DeviceSession`（`revoked_at = NOW()`），并级联撤销该会话下的全部历史和当前刷新凭证；
   - 抛出 409 `REFRESH_REUSE_DETECTED`；
   - 后续使用该会话下任何 Token（包括已被攻击者或原客户端获取的 successor）均立即返回 401 `REFRESH_TOKEN_REVOKED` / `SESSION_REVOKED`。
4. **Fastify 刷新端点挂载 (`apps/api/src/routes/auth-routes.ts`)**：
   - 挂载 `POST /api/v1/auth/refresh`；
   - 严格绑定 TypeBox `RefreshTokenRequestSchema` 与 `RefreshTokenResponseSchema`；
   - 响应包含 `accessToken`、`refreshToken`、`expiresIn` 与回显的 `rotationId`。
5. **真实 PostgreSQL 18 集成测试验证 (`tests/integration/auth-refresh.test.ts`)**：
   - `R-01`：标准原子刷新成功生成 successor 并标记旧凭据已使用且链接到新凭据；
   - `R-02`：同 rotationId 在 60 秒内重发准确返回相同响应（不产生额外凭证）；
   - `R-03`：不同 rotationId 重用立即触发 409 `REFRESH_REUSE_DETECTED` 并级联吊销整个会话家族；
   - `R-04`：不存在的随机刷新令牌返回 401 `INVALID_REFRESH_TOKEN`。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `apps/api/src/auth/replay-store.ts` | 新增 | 基于 Redis / 内存的 60 秒刷新重发容错缓存 |
| `apps/api/src/auth/session-service.ts` | 修改 | 实现严格锁序原子刷新 `rotateRefreshToken` 与重用熔断逻辑 |
| `apps/api/src/routes/auth-routes.ts` | 修改 | 挂载 `POST /api/v1/auth/refresh` 路由 |
| `apps/api/src/app.ts` | 修改 | 注册 RefreshTokenResponseSchema 并传递 pool 与 replayStore |
| `tests/integration/auth-refresh.test.ts` | 新增 | 针对真实 PG18 的刷新轮换与重放检测完整集成测试套件 |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 auth-refresh.test.ts |
| `evidence/tasks/SH-03B/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:lint
# Output:
# Architecture check passed (58 TypeScript source files).

npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)
```

### 3.2 单元测试套件（84 项全部通过）
```bash
npm run backend:test:unit
# Output:
# ℹ tests 84
# ℹ suites 1
# ℹ pass 84
# ℹ fail 0
```

### 3.3 真实 PG18 集成测试（32 项全部通过）
```bash
python3 scripts/test-integration.py
# Output:
# Legacy import integration PASS: atomic rollback, same batch retry, changed batch refusal, multi-family composite FK, user deletion preserves shared baby, archive private.
# ▶ SH-03B: Refresh Token Rotation & Replay Reuse Detection suite
#   ✔ R-01: Atomic refresh rotation issues successor and marks predecessor used (17.263542ms)
#   ✔ R-02: Same rotationId replay within 60s returns cached successor (lost response tolerance) (1.810541ms)
#   ✔ R-03: Token reuse with different rotationId triggers 409 and revokes session family (3.312959ms)
#   ✔ R-04: Non-existent refresh token fails closed with 401 INVALID_REFRESH_TOKEN (0.810167ms)
# ✔ SH-03B: Refresh Token Rotation & Replay Reuse Detection suite (365.257125ms)
# ▶ SH-03A: Authentication, DeviceSession, and Principal resolution suite
#   ✔ A-01: User registration creates user, default family, and initial session (242.705583ms)
#   ✔ A-02: Username duplicate registration rejected with 409 USERNAME_EXISTS (2.0195ms)
#   ✔ A-03: User login with valid credentials creates new session (75.47825ms)
#   ✔ A-04: User login with invalid password rejected with 401 INVALID_CREDENTIALS (70.405041ms)
#   ✔ A-05: Legacy bcrypt hash transparently upgraded on successful login (321.731583ms)
#   ✔ A-06: Authenticated request resolves UserPrincipal and accesses /me (12.344ms)
#   ✔ A-07: List active sessions returns all active DeviceSessions (15.485334ms)
#   ✔ A-08: Logout revokes session and subsequent requests fail with 401 (10.609125ms)
#   ✔ A-09: Explicit session revocation by ID terminates that session only (158.200125ms)
# ✔ SH-03A: Authentication, DeviceSession, and Principal resolution suite (1019.690917ms)
# ✔ SH-02A: foundation migration applies cleanly and establishes all core tables (44.819667ms)
# ...
# ✔ SH-02B: UnitOfWork full transaction and concurrency suite (282.509666ms)
# ℹ tests 32
# ℹ suites 0
# ℹ pass 32
# ℹ fail 0
# ℹ duration_ms 2636.057834
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

### 3.4 证据形态校验
```bash
npm run backend:evidence:check -- --task SH-03B
# Output:
# Evidence shape check passed for SH-03B (1 files).
```

---

## 4. 下一步工作

推进 **SH-03C: 家庭与宝宝逐级授权 (Family & Baby Authorization)**：
- 落实 `08_ACCOUNT_BABY_RELATIONSHIPS.md` 与 `09_WEB_IOS_SHARED_BACKEND.md` 第 8 节；
- 实现家庭创建、家庭成员列表、邀请码创建与加入；
- 实现宝宝创建、宝宝成员列表、显式宝宝邀请与撤销；
- 实施“最后活跃宝宝管理员保护”（`canRevokeBabyMember` 锁内重验）；
- 编写两个家庭、多宝宝、admin/member/viewer 权限交叉与写入竞争测试。
