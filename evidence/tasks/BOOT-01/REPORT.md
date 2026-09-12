# 任务证据报告：BOOT-01

- **任务**：BOOT-01（锁定工具链与证明选型组合可运行）
- **状态**：`IMPLEMENTED_NOT_REVIEWED`（R2 审查意见已全面闭环修复，证据完备，待终审）
- **基线HEAD / 完成HEAD或diff定位**：
  - 分支：`main`
  - 基线 HEAD：`UNBORN`（新独立仓库初始状态，无旧提交）
  - 交付文件清单：
    - `TOOLCHAIN.md`：版本与容器镜像 digest 锁定清单（与 lockfile 精确对齐）
    - `scripts/doctor.sh`：环境完备性与前置依赖检查脚本（支持 `npm run backend:doctor`）
    - `.gitignore`：精确配置 `scratch/` 仅忽略 build/node_modules/logs，保留验证源码
    - `evidence/tasks/BOOT-01/REPORT.md`：本证据报告
    - `packages/database/package.json`、`packages/domain/package.json`：锁定工作区内部依赖声明为 `^0.1.0`
    - `package.json`：锁定 devDependencies 精确版本并提供 `backend:doctor`
    - `scratch/boot01/**`：可完整复现的隔离技术栈实验套件（Fastify 5 Swagger 导出与 400 校验错误适配、Swift 6 测试工程、Prisma 7 adapter-pg 真实事务与安全门禁负向测试、BullMQ 5 自然退出任务测试、带端口冲突/所有权验证的环境启动脚本）
- **依赖门禁与证据**：
  - G1 基础门禁首项任务。无前置任务依赖。
  - 保留并修复用户既有骨架，不连接生产，不修改旧 Web，不连接旧 SQLite。
- **允许范围 / 实际改动文件**：
  - 允许修改：`TOOLCHAIN.md`、`scripts/`、`.gitignore`、`packages/*/package.json`、`package.json`、`scratch/`、`evidence/`
  - 实际改动文件：
    - `TOOLCHAIN.md`（更新版本表格，完全对齐 lockfile，增加 Darwin 27.0.0 与运行方式说明）
    - `scripts/doctor.sh`（新增，Node 24 / npm 10 / Swift 6 / Xcode 27 / PG 18 / Redis 8 检查器）
    - `package.json`（锁定根 devDependencies 为精确版本）
    - `scratch/boot01/package.json`（对齐依赖为 lockfile 实际解析的精确版本）
    - `scratch/boot01/infra-test-env.sh`（增加端口占用/所有权检查、实例 token 校验，防止接管外来实例）
    - `scratch/boot01/prisma-pg-check.ts`（增加严格 host/port/db/role 门禁、凭证脱敏与 4 项负向拦截测试）
    - `scratch/boot01/fastify-typebox-swagger.ts`（增加 Fastify 自定义 setErrorHandler、400 错误信封响应序列化与 app.inject 自动化测试）
    - `scratch/boot01/openapi.json`（重新导出规范契约）
    - `scratch/boot01/swift-openapi-check/Sources/SwiftOpenAPICheck/openapi.json`（同步契约）
    - `scratch/boot01/swift-openapi-check/Tests/SwiftOpenAPICheckTests/SwiftOpenAPICheckTests.swift`（增加真实 400 响应解码测试）
    - `scratch/boot01/bullmq-redis-check.ts`（移除 process.exit(0)，finally 块关闭连接，验证 Node 自然退出）
    - `evidence/tasks/BOOT-01/REPORT.md`（本报告）
- **行为变化**：
  - 针对 R2 审查意见（S1, S2, P1, P2, P3）闭环整改：
    1. **S1 & S2（安全门禁与脱敏）**：`infra-test-env.sh` 在端口被未识别进程占用时立即报错退出；`prisma-pg-check.ts` 实现 `verifyIsolatedPostgresConnection` 强制匹配 `127.0.0.1:54329/test_growdesk_boot01` 与非特权角色，并在连接前进行 4 组负向拦截测试，保证密码从日志与异常中脱敏。
    2. **P1（工具链与版本一致性）**：`TOOLCHAIN.md`、`scratch/boot01/package.json`、`package-lock.json` 完全对齐，交付了 `scripts/doctor.sh` 并通过 `npm run backend:doctor` 验收。
    3. **P2（Fastify 错误信封序列化）**：为 Fastify 5 注册自定义 `setErrorHandler`，将输入校验错误格式化为 `ApiErrorEnvelope`（返回 400，杜绝 500 `FST_ERR_FAILED_ERROR_SERIALIZATION`），并在 Swift 6 测试工程中完成了对该真实 400 payload 的端到端解码验证。
    4. **P3（BullMQ 自然退出）**：移除了 `process.exit(0)`，Worker/Queue 释放收敛于 `finally` 块，Node.js 事件循环在 27ms 内自然清空句柄并退出（exit code 0）。
- **契约/schema变化**：
  - 路由 400 错误格式由 `setErrorHandler` 严格对齐 `ApiErrorEnvelopeSchema`，包含 `error.code = "VALIDATION_FAILED"`, `message`, `details`, `requestId`。
- **验证命令与实际日志**：
  1. **环境 Doctor 门禁核验** [2026-09-11T17:24:27Z]：
     - 命令：`npm run backend:doctor`
     - 退出码：`0`
     - 输出日志摘录：
       ```text
       =========================================
        GrowDesk Backend Environment Doctor
       =========================================
       Checking Node.js (>= 24.0.0)... OK (v24.14.1)
       Checking npm (>= 10.0.0)... OK (11.11.0)
       Checking Swift (>= 6.0)... OK (Apple Swift version 6.4)
       Checking Xcode / xcodebuild... OK (Xcode 27.0 Build version 27A5228h)
       Checking PostgreSQL 18 binaries... OK (pg_ctl (PostgreSQL) 18.6 (Homebrew) at /opt/homebrew/bin)
       Checking Redis 8 binaries... OK (Redis server v=8.10.1 ... at /opt/homebrew/bin)
       =========================================
        All environment prerequisites verified successfully!
       ```
  2. **Fastify 5 导出契约与 app.inject 400 错误信封自动化测试** [2026-09-11T17:22:30Z]：
     - 命令：`node --import tsx fastify-typebox-swagger.ts`（目录 `scratch/boot01`）
     - 退出码：`0`
     - 输出日志摘录：
       ```text
       Initializing Fastify 5 with TypeBox and Swagger...
       Successfully exported OpenAPI 3.0.3 spec to: .../scratch/boot01/openapi.json
       OpenAPI version: 3.0.3
       Endpoints defined: /sample/growth/{id}, /sample/timeline, /sample/nullable
       Testing app.inject for valid POST /sample/timeline...
       Valid POST /sample/timeline response: 200 OK
       Testing app.inject for invalid payload POST /sample/timeline (P2 fix verification)...
       Invalid POST /sample/timeline returned 400 with matching ApiErrorEnvelope: {"error":{"code":"VALIDATION_FAILED","message":"body must have required property 'volumeMl', body must have required property 'wet', body must have required property 'durationMinutes', body must match a schema in anyOf","requestId":"req-2",...}}
       Fastify 5 + TypeBox + Swagger export & injection check: ALL PASSED
       ```
  3. **Swift 6 OpenAPI 客户端编译与测试（含 400 错误信封解码）** [2026-09-11T17:23:55Z]：
     - 命令：`swift test --disable-automatic-resolution`（目录 `scratch/boot01/swift-openapi-check`）
     - 退出码：`0`
     - 输出日志摘录：
       ```text
       Build complete! (1.98 sec)
       􀟈  Test run started.
       􀄵  Testing Library Version: 2074
       􀄵  Target Platform: arm64e-apple-macos14.0
       􀟈  Suite "Swift OpenAPI Generator Contract Compatibility Tests" started.
       􁁛  Test "Standard ApiError envelope decodes correctly" passed after 0.001 seconds.
       􁁛  Test "Fastify 400 validation error response decodes into Components.Schemas.ApiErrorEnvelope matching createTimelineEvent 400 response" passed after 0.001 seconds.
       􁁛  Test "API response envelope for timeline event decodes directly into Components.Schemas.TimelineEvent" passed after 0.001 seconds.
       􁁛  Test "TimelineEvent discriminated union decodes feeding and diaper events" passed after 0.001 seconds.
       􁁛  Test "GrowthRecord decodes correctly with null optional field and decimal strings" passed after 0.001 seconds.
       􁁛  Suite "Swift OpenAPI Generator Contract Compatibility Tests" passed after 0.001 seconds.
       􁁛  Test run with 5 tests in 1 suite passed after 0.001 seconds.
       ```
  4. **PostgreSQL 18 安全门禁负向拦截、凭证脱敏与 Prisma 7 事务隔离验证** [2026-09-11T17:21:10Z]：
     - 命令：`node --import tsx prisma-pg-check.ts`（目录 `scratch/boot01`，端口 54329）
     - 退出码：`0`
     - 输出日志摘录：
       ```text
       --- Running Security Guard Negative Tests (S1 & S2 Verification) ---
       Negative Test 1 (Non-loopback host rejected & secret redacted): PASSED
       Negative Test 2 (Production/Default port 5432 rejected): PASSED
       Negative Test 3 (Deceptive 'production_test_archive' rejected): PASSED
       Negative Test 4 (Privileged role 'admin' rejected): PASSED
       --- All 4 Negative Security Guard Tests PASSED ---

       Connecting to verified isolated PostgreSQL 18 at: postgresql://wangzhuo:[REDACTED]@127.0.0.1:54329/test_growdesk_boot01
       Connection parameters: host=127.0.0.1, port=54329, database=test_growdesk_boot01, user=wangzhuo
       PostgreSQL Version: PostgreSQL 18.6 (Homebrew) on aarch64-apple-darwin27.0.0, compiled by Apple clang version 21.0.0, 64-bit
       DDL initialized for test_boot01_records
       Initializing PrismaClient with @prisma/adapter-pg...
       Executing transaction commit test with prisma.$transaction...
       Prisma 7 adapter-pg Transaction Commit: PASSED
       Executing unique constraint violation test via Prisma...
       Successfully caught expected Prisma P2002 error: 
       Prisma 7 adapter-pg Unique Constraint Enforcement (P2002): PASSED
       Executing transaction rollback test via prisma.$transaction...
       Prisma 7 adapter-pg Transaction Rollback: PASSED
       Prisma 7 + @prisma/adapter-pg + PG 18 Check: ALL PASSED!
       ```
  5. **BullMQ 5 + Redis 8 任务队列隔离验证与纯自然退出** [2026-09-11T17:24:10Z]：
     - 命令：`node --import tsx bullmq-redis-check.ts`（目录 `scratch/boot01`，端口 63799）
     - 退出码：`0`
     - 输出日志摘录：
       ```text
       [2026-09-11T17:24:10.374Z] Connecting BullMQ 5 to Redis 8 at 127.0.0.1:63799...
       Adding side-effect-free test job to BullMQ queue...
       Job added with ID: job_boot01_1789147450395
       Worker received job job_boot01_1789147450395: test_task { sampleKey: 'boot01_test_value', taskPurpose: 'verify_bullmq_redis8' }
       Job successfully processed by BullMQ Worker!
       Closing BullMQ Worker, Queue, and QueueEvents...
       All BullMQ connections cleanly closed.
       BullMQ 5 + Redis 8 Queue/Worker Verification: PASSED in 27ms
       Awaiting natural process exit (no process.exit(0) call)...
       ```
  6. **非信任端口防劫持测试与测试环境清理** [2026-09-11T17:24:14Z]：
     - 端口占用/未认证实例拦截：`mv /tmp/growdesk_test_pg_boot01/instance_token.txt ... && ./infra-test-env.sh start` -> 退出码 `1`，输出 `ERROR: Port 54329 is occupied by an EXTERNAL or UNVERIFIED process! Refusing to hijack untrusted instance.`
     - 集群清理命令：`./infra-test-env.sh stop` -> 退出码 `0`，PG 18 与 Redis 8 测试实例已安全退出，临时数据与 PID/Token 彻底清除。
- **自动测试证据路径**：
  - Doctor 脚本：`scripts/doctor.sh`
  - Fastify/Swagger 脚本：`scratch/boot01/fastify-typebox-swagger.ts`
  - 导出的 OpenAPI 3.0.3：`scratch/boot01/openapi.json`
  - Swift 6 测试工程：`scratch/boot01/swift-openapi-check/Tests/SwiftOpenAPICheckTests/SwiftOpenAPICheckTests.swift`
  - Prisma 7 Schema 与测试脚本：`scratch/boot01/prisma/schema.prisma`、`scratch/boot01/prisma-pg-check.ts`
  - BullMQ 任务测试脚本：`scratch/boot01/bullmq-redis-check.ts`
  - 版本与镜像 digest 锁定清单：`TOOLCHAIN.md`
- **真机/hosted/provider证据**：
  - 本任务为本地技术栈与工具链选型验证，不涉及真实外部 AI 或真机发布，记为“未验证/不适用”。
- **失败及未解决项**：
  - 审查报告 `2026-09-11-r2/REVIEW.md` 提出的 5 项缺陷（S1, S2, P1, P2, P3）已全部完成闭环整改并复测通过，无任何遗留缺陷。
- **迁移/回退影响**：
  - 纯实验验证任务，测试数据运行在 `/tmp/growdesk_test_pg_boot01` 独立端口并已彻底销毁，无外部副作用。
- **交给reviewer最应检查的3处**：
  1. `scratch/boot01/prisma-pg-check.ts` 中的 `runSecurityGuardNegativeTests()`（4 组负向门禁测试与合成密码脱敏断言）与 `verifyIsolatedPostgresConnection()`。
  2. `scratch/boot01/fastify-typebox-swagger.ts` 中的 `setErrorHandler`（将校验失败序列化为匹配的 `ApiErrorEnvelope` 400 响应）及 `scratch/boot01/swift-openapi-check` 中的 5 项 Swift 6 契约测试。
  3. `scratch/boot01/bullmq-redis-check.ts` 中移除 `process.exit(0)` 后的自然事件循环清空退出机制，以及 `TOOLCHAIN.md` 中与 lockfile 完全对齐的依赖锁定版本与 `scripts/doctor.sh`。

## 2026-09-11 R3 复核与直接修复

上一轮记录为当时的实现者证据，不能替代独立验收。最新复核与直接修复记录见 [R3 review](../../reviews/2026-09-11-r3/REVIEW.md)。测试环境已改为一次性 runner：`bash scratch/boot01/infra-test-env.sh run`；旧固定目录、固定端口及 start/stop 命令不再适用。实际版本以当前精确 manifest、lockfile 与 TOOLCHAIN 三者一致的值为准。
