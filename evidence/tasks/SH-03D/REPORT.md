# 任务执行报告：SH-03D 密码修改与恢复码

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`2a9791d` (SH-03C)  
> 依赖前置：`SH-03A`、`SH-03B`、`SH-03C` (已全部完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 8 节（SH-03 任务卡）及 `02_BACKEND_CONTRACTS.md` 第 3.1 节规范，实施 **SH-03D 密码修改与单次恢复码** 机制：

1. **密码修改 (`POST /api/v1/auth/password/change`)**：
   - 依赖已认证会话 (`fastify.authenticate`)，必须验证原密码 `verifyPassword(oldPassword, user.passwordHash)`；
   - 遵循规范第 3.3 节全局锁序：事务开始首先锁定 `UserSyncState(userId) FOR UPDATE`；
   - 新密码采用 bcrypt cost 12 重新哈希，递增 `password_hash_version`；
   - 依据 02 规范“旧密码再验证，撤销其他会话”，原子撤销该用户除当前会话外的所有其他 `DeviceSession` 和 `RefreshCredential`，当前客户端保持登录状态；
   - 原子递增 `UserSyncState.cursor`。

2. **单次恢复码批量生成与重置 (`POST /api/v1/auth/recovery-codes/regenerate`)**：
   - 依赖已认证会话，必须再验证当前用户密码，防止会话劫持后恶意作废恢复因子；
   - 严格遵循全局锁序锁定 `UserSyncState(userId)`；
   - 一次性生成 10 组 128-bit 安全随机恢复码，格式化为 `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`，仅在本次响应中明文返回一次；
   - 归一化后计算 SHA-256 哈希存入 `recovery_codes` 表，绑定唯一 `batch_id`；
   - 原子作废旧批次未使用的恢复码 (`UPDATE recovery_codes SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND used_at IS NULL`)；
   - 恢复码明文和哈希严格禁止进入变更日志 (`UserChange`) 或控制台日志。

3. **使用恢复码重置密码 (`POST /api/v1/auth/password/recover`)**：
   - 公开非认证端点，接收 `username`、`recoveryCode`、`newPassword`；
   - 恒定错误文案与防枚举设计：若用户不存在、已删除、恢复码不存在、已使用或已撤销，统一返回 401 `INVALID_RECOVERY_CODE`（"Invalid username or recovery code"）；
   - 严格遵循全局锁序：`UserSyncState(user.id) FOR UPDATE -> RecoveryCode(code_hash, user.id) FOR UPDATE`；
   - 单次消费保证：原子更新目标码 `used_at = NOW()`；
   - 批次失效保证：原子撤销该批次下所有剩余未使用的恢复码 (`revoked_at = NOW()`)；
   - 账号安全保障：更新用户密码哈希至新密码 (cost 12)，原子撤销该用户所有的 `DeviceSession` 和 `RefreshCredential`（强制历史设备全部下线）；
   - 原子递增 `UserSyncState.cursor`；
   - 用户使用新密码重新登录并引导重新生成新批次恢复码。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `apps/api/src/auth/recovery-service.ts` | 新增 | 恢复码生成、归一化、哈希、密码修改事务与恢复事务核心服务 |
| `apps/api/src/routes/auth-routes.ts` | 修改 | 挂载 3 个密码与恢复码端点 (`/password/change`, `/recovery-codes/regenerate`, `/password/recover`) |
| `apps/api/src/app.ts` | 修改 | 注册 `RegenerateRecoveryCodesResponseSchema` 保证架构与 Fastify 校验契约一致 |
| `tests/integration/auth-recovery.test.ts` | 新增 | 13 项针对真实 PG18 的密码修改、恢复码轮换与重置测试 |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 `auth-recovery.test.ts` |
| `evidence/tasks/SH-03D/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 架构分层、ESLint 与类型检查
```bash
npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)

npm run backend:lint
# Output:
# Architecture check passed (62 TypeScript source files).
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

### 3.4 真实 PostgreSQL 18 & Redis 集成测试套件（59 项全部通过）
```bash
npm run backend:test:integration
# Output:
# ▶ SH-03D: Password Change & Recovery Codes suite
#   ✔ Setup: Register user (498.244542ms)
#   ✔ Setup: Second login creates session 2 (77.463125ms)
#   ✔ RC-01: Change password with wrong current password fails with 401 (86.071458ms)
#   ✔ RC-02: Change password with valid credentials revokes session 2 while keeping session 1 (369.134ms)
#   ✔ RC-03: Login verifies new password and rejects old password (607.103083ms)
#   ✔ RC-04: Regenerate recovery codes with wrong password fails with 401 (286.181083ms)
#   ✔ RC-05: Regenerate recovery codes returns 10 codes and batchId (295.0785ms)
#   ✔ RC-06: Regenerating second batch revokes first batch in DB (292.860083ms)
#   ✔ RC-07: Recovery with revoked code from batch 1 fails with 401 (2.19675ms)
#   ✔ RC-08: Recovery with wrong username or bogus code fails closed with 401 (1.443042ms)
#   ✔ RC-09: Valid recovery code resets password, marks code used, revokes batch and all sessions (292.96625ms)
#   ✔ RC-10: Re-using the consumed recovery code fails with 401 (1.223584ms)
#   ✔ RC-11: User can login with new recovered password (293.945709ms)
# ✔ SH-03D: Password Change & Recovery Codes suite (3227.006833ms)
# ...
# ℹ tests 59
# ℹ suites 0
# ℹ pass 59
# ℹ fail 0
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

---

## 4. 下一步计划

本任务为 **SH-03D**，标志着 **SH-03（账号、会话与宝宝授权）** 四个子任务（`SH-03A` 注册/登录/会话、`SH-03B` 令牌轮换与重放检测、`SH-03C` 家庭与宝宝逐级授权、`SH-03D` 密码修改与恢复码）全部顺利交付并通过 PG18 严苛验证。

根据 `09_WEB_IOS_SHARED_BACKEND.md` 第 9 节任务卡规划，下一阶段进入 **SH-04: 按领域交付完整记录链路**。
第一项为 **SH-04F: 喂养记录链路 (Feeding Record Pipeline)**：
- 落地喂养所需的 `FormulaProduct` 最小正式模型与家庭归属校验；
- 实施 FeedingRecord 领域服务与 Scoped Repository（支持奶量、亲喂时长、吐奶性状、历史营养快照与乐观锁）；
- 挂载 `POST/GET/PATCH/DELETE` 喂养路由及历史列表端点；
- 编写真实 PG18 事务与并发集成测试（同 mutationId 重放、乐观锁冲突、跨宝宝隔离）。
