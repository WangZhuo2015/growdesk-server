# 任务执行报告：SH-03C 家庭与宝宝逐级授权

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-12  
> 目标仓库：`/Users/wangzhuo/Documents/GitHub/growdesk-server`  
> 分支：`codex/backend-storage-foundation`  
> 基线提交：`ab1c6fe29bbfd21ebfaeb62f397f354c4ff345b5` (SH-03B)  
> 依赖前置：`SH-03A`、`SH-03B` (已完成并验证)

---

## 1. 目标与实现概述

按 `09_WEB_IOS_SHARED_BACKEND.md` 第 8 节（SH-03）、第 70 行拆分规则，以及 `08_ACCOUNT_BABY_RELATIONSHIPS.md` 与 `02_BACKEND_CONTRACTS.md` 第 3.1 & 3.3 节规范，实施 **SH-03C 家庭与宝宝逐级授权**：

1. **家庭与宝宝多对多逐级授权模型严格落地 (`apps/api/src/services/family-baby-service.ts`)**：
   - 用户与宝宝显式多对多，`FamilyMember` 与 `BabyMember` 共同约束；无全局 `activeBabyId` 旁路；
   - 用户属于家庭**绝不等于**拥有家庭内所有宝宝权限；
   - `listFamilyBabies` (`GET /api/v1/families/:id/babies`)：数据库查询严格通过 `members: { some: { userId, status: "active" } }` 联结过滤，新成员加入家庭后对既有宝宝零权限，杜绝内存中过滤或泄漏；
   - `createFamilyBaby` (`POST /api/v1/families/:id/babies`)：原子事务内创建 `Baby` 并赋予创建者 `BabyMember(role: "admin", status: "active")`。

2. **严格遵循规范第 3.3 节全局锁顺序**：
   - 全局锁序：`UserSyncState(按 userId 锁定) -> FamilySyncState(按 familyId 锁定) -> 业务实体`；
   - 创建家庭时锁定 `UserSyncState`；所有家庭/宝宝/成员变更均在事务开始时先锁定 `FamilySyncState(familyId) FOR UPDATE`，在持有行锁的前提下重新验证权限与成员不变量；
   - 任何权限与关系变动均原子递增 `FamilySyncState.permissionVersion`，使前端/客户端缓存游标失效。

3. **家庭邀请与加入机制**：
   - `POST /api/v1/families/:id/invites`：生成高熵随机邀请码，计算 HMAC-SHA256 存储于 `LegacyInviteCodeMapping`，禁止暴露明文哈希，支持到期时间与单次使用限制；
   - `GET /api/v1/families/invites/preview`：公开预览端点，无需鉴权即可获取家庭名称与邀请者展示名，绝不泄漏家庭其他成员列表；
   - `POST /api/v1/families/join`：在 `FamilySyncState` 行锁下原子兑换邀请码，幂等处理重复加入，加入者初始角色为普通 `member`，且不自动赋予任何宝宝权限。

4. **双重最后管理员保护不变量 (Last-Admin Safeguards)**：
   - **最后家庭管理员保护 (`LAST_FAMILY_ADMIN_PROTECTION`)**：当目标成员为家庭唯一的活跃管理员时，禁止降级或移除；
   - **最后活跃宝宝管理员保护 (`LAST_BABY_ADMIN_PROTECTION`)**：
     - 在事务锁内调用 `@growdesk/domain` 中的 `canRevokeBabyMember` 纯策略函数进行严格判定；
     - 当目标照护者为家庭下任一宝宝的唯一活跃管理员时，禁止从家庭移除或主动退出家庭（返回 409 冲突，要求先转移宝宝管理员）；
     - 直接调用宝宝照护者移除接口 (`DELETE /api/v1/babies/:id/members/:userId`) 尝试撤销最后管理员时同样触发 409 阻断。

5. **照护者级联与账号隔离**：
   - 当成员从家庭被移除或退出时，级联将该家庭下该用户的所有 `BabyMember` 标记为 `revoked`，递增 `permissionVersion`；
   - 不 cascade 删除共享 `Baby` 或业务记录。

6. **OpenAPI 3.0.3 规范与 Fastify 路由注册**：
   - 在 `@growdesk/contracts` 中扩展补齐 `BabyMemberSchema`、`BabyMemberListResponseSchema`、`AddBabyMemberRequestSchema`、`RemoveBabyMemberResponseSchema`、`IdParamSchema`、`FamilyAndMemberParamSchema`；
   - 重新执行 `node scripts/generate-contracts.mjs`，OpenAPI 契约增至 86 路径、122 路由，与 `contracts/openapi.json` 零差异通过校验；
   - 在 Fastify 挂载 `familyRoutes` 与 `babyRoutes`，参数校验与错误处理完全遵循 `ApiErrorEnvelopeSchema` 统一错误信封。

---

## 2. 变更文件清单

| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `packages/contracts/src/common.ts` | 修改 | 导出 IdParamSchema 与 FamilyAndMemberParamSchema |
| `packages/contracts/src/family.ts` | 修改 | 新增 BabyMember 相关的 TypeBox 契约定义 |
| `packages/contracts/src/routes.ts` | 修改 | 声明宝宝照护者列表、添加与移除的正式端点契约 |
| `scripts/contract-generator.mjs` | 修改 | 注册 BabyMemberSchema 为 OpenAPI 共享组件 |
| `contracts/openapi.json` | 修改 | 同步生成包含 86 路径、122 路由的规范文档 |
| `apps/api/src/services/family-baby-service.ts` | 新增 | 家庭与宝宝逐级授权核心领域服务实现 |
| `apps/api/src/routes/family-routes.ts` | 新增 | 挂载 12 个家庭相关 HTTP 路由 |
| `apps/api/src/routes/baby-routes.ts` | 新增 | 挂载 5 个宝宝及照护者相关 HTTP 路由 |
| `apps/api/src/app.ts` | 修改 | 注册新 Schema 并挂载 familyRoutes 与 babyRoutes |
| `tests/integration/family-baby.test.ts` | 新增 | 12 项针对真实 PG18 的家庭与宝宝逐级授权集成测试套件 |
| `scripts/test-integration.py` | 修改 | 集成测试运行器增加 family-baby.test.ts |
| `evidence/tasks/SH-03C/REPORT.md` | 新增 | 本任务执行报告 |

---

## 3. 验证命令与结果证据

### 3.1 OpenAPI 契约与校验流水线（零差异）
```bash
node scripts/generate-contracts.mjs
# Output:
# Successfully generated /Users/wangzhuo/Documents/GitHub/growdesk-server/contracts/openapi.json
# - OpenAPI version: 3.0.3
# - Path count: 86
# - Operation count: 122
# - Schema component count: 44

node scripts/check-contracts.mjs
# Output:
# Contract check passed: /Users/wangzhuo/Documents/GitHub/growdesk-server/contracts/openapi.json is perfectly in sync (86 paths, 122 operations).
```

### 3.2 架构分层、ESLint 与类型检查
```bash
npm run backend:lint
# Output:
# Architecture check passed (61 TypeScript source files).

npm run backend:typecheck
# Output:
# tsc -p tsconfig.backend.json --noEmit (Exit 0)
```

### 3.3 单元测试套件（84 项全部通过）
```bash
npm run backend:test:unit
# Output:
# ℹ tests 84
# ℹ suites 1
# ℹ pass 84
# ℹ fail 0
```

### 3.4 真实 PG18 集成测试（45 项全部通过）
```bash
python3 scripts/test-integration.py
# Output:
# Legacy import integration PASS: atomic rollback, same batch retry, changed batch refusal, multi-family composite FK, user deletion preserves shared baby, archive private.
# ▶ SH-03B: Refresh Token Rotation & Replay Reuse Detection suite (4/4 PASS)
# ▶ SH-03A: Authentication, DeviceSession, and Principal resolution suite (9/9 PASS)
# ▶ SH-03C: Family and Baby Authorization & Management suite
#   ✔ FB-01: User A creates a new family -> User A is admin, permissionVersion is 1 (23.3485ms)
#   ✔ FB-02: User C creates Family 2; User A and C listFamilies return strictly isolated data (23.082417ms)
#   ✔ FB-03: Create family invite -> preview without auth works (10.436583ms)
#   ✔ FB-04: User B joins Family 1 via inviteCode -> becomes member, but has NO baby access (20.442292ms)
#   ✔ FB-05: User A creates Baby 1; User B cannot see Baby 1 in list or get (28.94475ms)
#   ✔ FB-06: User A adds User B as caregiver to Baby 1 -> User B now sees and gets Baby 1 (21.380667ms)
#   ✔ FB-07: Cross-tenant isolation: Cannot add User C (from Family 2) to Baby 1 (Family 1) (7.182667ms)
#   ✔ FB-08: Last family admin protection: User A cannot demote self while only admin (8.385583ms)
#   ✔ FB-09: Last baby admin protection: User A cannot be revoked from Baby 1 while only baby admin (15.462459ms)
#   ✔ FB-10: Promote User B to baby admin -> now User A can be revoked from Baby 1 (16.286875ms)
#   ✔ FB-11: Viewer permissions: demoting family member or baby role to viewer denies write/create (9.333083ms)
#   ✔ FB-12: Removing User A from Family 1 cascades revocation of baby membership (10.97525ms)
# ✔ SH-03C: Family and Baby Authorization & Management suite (838.432625ms)
# ▶ SH-02A / SH-02B suites (20/20 PASS)
# ℹ tests 45
# ℹ suites 0
# ℹ pass 45
# ℹ fail 0
```

---

## 4. 外部阻塞与下一步

- **外部阻塞**：无。
- **下一前置任务**：**`SH-03D (密码修改与恢复码)`**。
