# 任务执行报告：SH-06 附件、医疗报告、疫苗与通知链路 (Attachments, Medical Reports, Vaccines & Notifications)

> 状态：`IMPLEMENTED_VERIFIED_REVIEW_PENDING`  
> 执行人：Gemini Agent  
> 实施日期：2026-09-13  
> 目标仓库：
>   - `/Users/wangzhuo/Documents/GitHub/growdesk-server` (分支 `codex/backend-storage-foundation`)
> 基线提交：`a62f36c` (growdesk-server: SH-05), `8cfafc1` (baby_panel_for_cecilia: SH-05)  
> 依赖前置：`SH-01`、`SH-02A`、`SH-02B`、`SH-03A~D`、`SH-04F~TL`、`SH-05` (已全部完成并验证)

---

## 1. 目标与架构概述

依据 `docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md` 第 11 节（SH-06 任务卡）、`02_BACKEND_CONTRACTS.md` 与 `08_ACCOUNT_BABY_RELATIONSHIPS.md`：
本任务在 GrowDesk 共享后端建立完整的私有对象存储接入、医疗报告、疫苗接种计划与记录、以及移动/Web 推送设备注册链路：

1. **私有 S3 对象存储驱动与预签名直传架构 (`apps/api/src/storage/s3-storage-service.ts`)**：
   - 实现可插拔 `StorageDriver` 接口，支持生产环境 `AwsS3StorageDriver`（基于 `@aws-sdk/client-s3` 与 `@aws-sdk/s3-request-presigner`）以及本地测试环境 `MockStorageDriver`；
   - 预签名机制：客户端通过受控 API 获取具有 15 分钟短期时效的预签名 PUT 上传 URL 与 GET 受保护下载 URL，避免二进制数据经过应用服务器内存中转；
   - 两阶段上传确认：客户端必须调用 `POST /api/v1/attachments/:attachmentId/complete`，后端校验实际文件元数据（ContentType、ContentLength、ETag）并将附件状态置为 `ACTIVE`；
   - 物理/逻辑隔离：附件对象 Key 统一按 `families/:familyId/babies/:babyId/attachments/:id/:fileName` 组织，并严格检验 BabyMember 访问权限。

2. **医疗报告多租户 CRUD 与时间线原子投影 (`apps/api/src/services/medical-service.ts`)**：
   - 建立 `medical_reports` 表与 `medical_report_attachments` 关联映射；
   - 支持多附件级联绑定，提供报告标题、类型、就医/体检时间、医生诊断、医嘱及关键检验指标；
   - 严格落实 `baseVersion` 乐观并发控制，版本冲突时抛出 409 `CONCURRENCY_CONFLICT`；
   - 深度集成 UnitOfWork，创建/修改/删除医疗报告时在单一数据库事务内原子维护 `timeline_entries` 投影，实现多护理领域统一时间线展现。

3. **国家标准疫苗计划与接种记录 (`apps/api/src/services/vaccine-service.ts`)**：
   - 建立 `vaccine_schedules`（稳定业务编码 `vaccineCode`、剂次、推荐月龄与接种窗口）与 `vaccine_records`（宝宝实际接种批号、部位、接诊诊所、反应与备忘）；
   - 区分稳定业务 ID 与数据库主键，支持自费与一类免费疫苗分类；
   - 接种记录同样原子投影至 `timeline_entries`，支持按宝宝权限隔离检索。

4. **推送设备注册与通知生命周期 (`apps/api/src/services/notification-service.ts`)**：
   - 建立 `push_devices`（绑定安装设备 `installationId`、平台 APNs/FCM、推送 Token 与活跃时间）；
   - 建立 `notifications` 表，支持未读状态标记、批量已读与逐宝宝/逐用户通知隔离。

---

## 2. 变更文件清单

### 后端服务 (`growdesk-server`)
| 文件路径 | 变更类型 | 说明 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | 新增 `Attachment`, `MedicalReport`, `MedicalReportAttachment`, `VaccineSchedule`, `VaccineRecord`, `PushDevice`, `Notification` 模型 |
| `prisma/migrations/202609120010_attachments_medical_vaccines/migration.sql` | 新增 | 创建 7 张核心表、索引、外键级联与软删除过滤索引 |
| `packages/database/src/errors.ts` | 修改 | 新增 `BadRequestError` (400) 映射 |
| `apps/api/src/storage/s3-storage-service.ts` | 新增 | S3 存储驱动抽象与 Mock/AWS S3 实现 |
| `apps/api/src/services/attachment-service.ts` | 新增 | 附件预签名生成、状态流转与租户隔离服务 |
| `apps/api/src/services/medical-service.ts` | 新增 | 医疗报告 CRUD、baseVersion 乐观锁与时间线原子投影 |
| `apps/api/src/services/vaccine-service.ts` | 新增 | 标准疫苗计划推荐、实际接种记录与时间线投影 |
| `apps/api/src/services/notification-service.ts` | 新增 | 设备推送 Token 注册与用户通知检索/标记 |
| `apps/api/src/routes/attachment-routes.ts` | 新增 | 附件相关 REST 接口路由 |
| `apps/api/src/routes/medical-routes.ts` | 新增 | 医疗报告与疫苗接种 REST 接口路由 |
| `apps/api/src/routes/notification-routes.ts` | 新增 | 设备推送与通知 REST 接口路由 |
| `apps/api/src/app.ts` | 修改 | 注册附件、医疗与通知路由插件 |
| `tests/integration/attachments.test.ts` | 新增 | 附件预签名上传、下载与鉴权集成测试 (7 项测试) |
| `tests/integration/medical-vaccines.test.ts` | 新增 | 医疗报告/疫苗/通知业务流程集成测试 (12 项测试) |
| `scripts/test-integration.py` | 修改 | 注册 `attachments.test.ts` 与 `medical-vaccines.test.ts` |
| `tests/integration/foundation-migration.test.ts` | 修改 | 纳入迁移 `202609120010_attachments_medical_vaccines` 结构断言 |
| `package.json`, `package-lock.json` | 修改 | 引入 `@aws-sdk/client-s3` 与 `@aws-sdk/s3-request-presigner` |

---

## 3. 验证命令与测试证据

### 3.1 架构、代码风格与类型检查
```bash
npm run backend:build
npm run backend:lint
npm run backend:typecheck
npm run backend:contracts:check

# 检查输出：
# Architecture check passed (94 TypeScript source files).
# Contract check passed: contracts/openapi.json is perfectly in sync (86 paths, 123 operations).
```

### 3.2 真实 PostgreSQL 18 & Redis 集成测试套件（162 项全部通过）
```bash
python3 scripts/test-integration.py

# 附件与医疗疫苗通知套件执行证据：
# ▶ SH-06: S3 Attachments Pipeline suite
#   ✔ Setup: Register User A and create Baby A
#   ✔ ATT-01: Create attachment returns presigned upload URL and pending entity
#   ✔ ATT-02: Complete attachment marks status active and sets actual size
#   ✔ ATT-03: Get attachment returns presigned download URL
#   ✔ ATT-04: User B cannot access Baby A's attachment (403)
#   ✔ ATT-05: Delete attachment marks deleted_at and prevents download
#   ✔ ATT-06: Create attachment with invalid payload fails validation
# ✔ SH-06: S3 Attachments Pipeline suite
#
# ▶ SH-06: Medical Reports, Vaccines & Notifications Pipeline suite
#   ✔ Setup: Register User A and User B, create babies
#   ✔ MED-01: Create medical report and verify atomic timeline projection
#   ✔ MED-02: Idempotency replay with same key returns cached result
#   ✔ MED-03: Keyset pagination works stably across reports
#   ✔ MED-04: baseVersion optimistic concurrency conflict detection
#   ✔ MED-05: User B cannot access Baby A's medical report
#   ✔ MED-06: Delete medical report soft-deletes and removes timeline projection
#   ✔ VAC-01: Get standard vaccine schedule returns recommendations
#   ✔ VAC-02: Create vaccine record and verify atomic timeline projection
#   ✔ VAC-03: List vaccine records returns baby's vaccinations
#   ✔ VAC-04: User B cannot access Baby A's vaccine records
#   ✔ VAC-05: Delete vaccine record removes record and timeline projection
#   ✔ NOTIF-01: Push device registration and notification listing
# ✔ SH-06: Medical Reports, Vaccines & Notifications Pipeline suite
#
# ℹ tests 162
# ℹ suites 0
# ℹ pass 162
# ℹ fail 0
# Owned PostgreSQL/Redis integration checks passed; test process exited successfully.
```

---

## 4. 结论与下一步

SH-06（附件、医疗报告、疫苗与通知链路）在 `growdesk-server` 中已全部实现，并通过了端到端真实数据库与驱动测试，架构与契约完全对齐。

接下来进入下一阶段：
- **`SH-07: 后台任务、AI 和通知统一 (Durable Task Engine & AI Workers)`**：
  - 任务状态机持久化（`task_runs`, `task_events`, `task_outbox`）；
  - 基于 Redis/BullMQ 的异步 Worker、租约控制（Worker Lease）与 Fencing Token；
  - 外部 AI 调用任务封装、幂等重放与 SSE 进度流断线重连。
