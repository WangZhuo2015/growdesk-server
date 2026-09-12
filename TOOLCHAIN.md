# GrowDesk 工具链与选型版本锁定清单 (TOOLCHAIN.md)

本文件依据 `BOOT-01` 在干净隔离环境中运行的最小技术栈组合实验（Fastify 5 + TypeBox + Swagger OpenAPI 3.0.3 + Swift 6 OpenAPI Generator + PostgreSQL 18 + Prisma 7 adapter-pg + Redis 8 + BullMQ 5）确定并锁定。

---

## 1. 运行时与编译器环境基线

| 组件 | 本机验证版本 | 目标/CI 版本 | 约束说明 |
|---|---|---|---|
| **Node.js** | `v24.14.1` | `>=24.0.0` (Node 24 LTS) | 根 package.json `engines.node` 强制限定 |
| **npm** | `11.11.0` | `>=10.0.0` | 使用 npm workspaces 管理多 package |
| **macOS** | `Darwin 27.0.0` (arm64) | macOS 14+ / Linux OCI | 本地开工与构建平台 (`uname -a`: Darwin 27.0.0) |
| **Xcode** | `27.0 (Build 27A5228h)` | Xcode 16+ / 27+ | 原生端编译基线 |
| **Swift** | `Apple Swift 6.4 (swiftlang-6.4.0.27.1)` | Swift 6.0+ | 启用 Swift 6 语言模式与严格并发检查 |

---

## 2. 后端核心依赖锁定清单（严格对齐 package-lock.json）

| 依赖包 | 锁定精确版本 | 职责与验证结论 |
|---|---|---|
| `fastify` | `5.12.4` | 业务 HTTP 服务宿主，非阻塞，原生插件支持 |
| `@fastify/type-provider-typebox` | `5.2.0` | 静态与运行时 TypeBox 类型桥接 |
| `@fastify/swagger` | `9.8.1` | 导出 OpenAPI 3.0.3 规范文档 |
| `@sinclair/typebox` | `0.34.52` | 单一 Schema 源，提供请求校验、响应序列化与 DTO |
| `prisma` | `7.10.0` | ORM CLI 与迁移管理工具 |
| `@prisma/client` | `7.10.0` | 数据库客户端 |
| `@prisma/adapter-pg` | `7.10.0` | Prisma 7 原生 PostgreSQL 驱动适配器 |
| `pg` | `8.23.0` | PostgreSQL 18 连接池驱动 |
| `@types/pg` | `8.23.1` | 与 Prisma 7.10 `@prisma/adapter-pg` 的 `pg` 类型定义保持一致 |
| `bullmq` | `5.81.5` | 分布式任务队列、心跳续租与 Fencing |
| `ioredis` | `5.11.1` | Redis 8 客户端与 Pub/Sub |
| `typescript` | `5.9.3` | TypeScript strict 编译器 |
| `tsx` | `4.23.13` | ESM TypeScript 执行器 |

---

## 3. Swift 客户端生成依赖（同步开发对齐）

| Swift Package | 锁定精确版本 | 职责与验证结论 |
|---|---|---|
| `apple/swift-openapi-generator` | `1.13.1` | SPM 构建插件，从 OpenAPI 3.0.3 编译时生成 Types 与 Client |
| `apple/swift-openapi-runtime` | `1.12.1` | OpenAPI 运行时传输与解码抽象 |
| `apple/swift-openapi-urlsession` | `1.3.1` | 基于原生 URLSession 的 HTTP 传输传输层 |

---

## 4. 基础设施与容器镜像精确锁定清单

| 服务/环境 | 本机验证版本（验证方式） | 隔离测试配置 | 生产/CI 镜像与精确 Digest（Linux OCI） |
|---|---|---|---|
| **CI 运行环境** | `Node.js 24.14` | GitHub Actions / Linux OCI | `node:24-alpine@sha256:333f6b3eca25980d5682c26207665b93c9417786b21760b2764d5821d9704c8a` |
| **PostgreSQL** | `18.6` (Homebrew 原生服务进程验证) | 每次运行随机 loopback 端口，私有临时目录 `/tmp/growdesk-boot01-*` | `postgres:18-alpine@sha256:63bdc97d67b5133bf0e5ebd500bec6d046fa851dc81340d838f0347e616107e8` |
| **Redis** | `8.10.1` (Homebrew 原生服务进程验证) | 每次运行随机 loopback 端口，私有临时目录与密码 | `redis:8-alpine@sha256:9c3ecc609a8087c0f11c494fefaf37a8f7bf9a967631d4a0da8967a9810be354` |

*说明：本地验证采用 Homebrew 原生编译运行的 PostgreSQL 18.6 与 Redis 8.10.1 守护进程，验证协议兼容与驱动行为；OCI 容器镜像 Digest 为 GitHub Actions 与生产 Linux 容器环境的不可变镜像锁定。在 npm monorepo 工作区内部，内部 package 间依赖统一使用 `0.1.0` / npm workspace 机制解析，禁止在第三方依赖中使用 `latest` 或 `*` 浮动版本。*

---

## 5. 跨端契约导出规则与陷阱避坑指南（BOOT-01 实测发现）

在本次隔离实验中发现并解决以下关键跨端兼容细节，所有后续服务端与 iOS 契约实现必须严格遵守：

1. **Ajv 校验严格模式对 OpenAPI `discriminator` 的拦截**：
   - **问题**：Fastify 5 默认启用 Ajv 严格模式，识别到 TypeBox 的 `discriminator` 关键字时会报错 `strict mode: unknown keyword: "discriminator"`。
   - **解决方式**：Fastify 启动参数必须配置：
     ```typescript
     Fastify({
       ajv: {
         customOptions: {
           keywords: ["discriminator"],
         },
       },
     })
     ```
2. **OpenAPI `components.schemas` 命名规整化**：
   - **问题**：`@fastify/swagger` 默认会将未显式解析的本地引用编号为 `def-0`, `def-1`，导致 Swift 生成的类型名变成 `Components.Schemas.Def0`。
   - **解决方式**：配置 `refResolver` 优先提取 `$id` 或 `title`：
     ```typescript
     refResolver: {
       buildLocalReference(json, _baseUri, _fragment, i) {
         return json.$id || (json.title as string) || `def-${i}`;
       },
     }
     ```
     并在 TypeBox 定义中统一标注 `$id`（如 `$id: "GrowthRecord"`），Swift 端即可获得语义化强类型 `Components.Schemas.GrowthRecord`。
3. **OpenAPI 3.0.3 的 Nullable 处理**：
   - TypeBox 定义可空字段使用：
     ```typescript
     const Nullable = <T extends ReturnType<typeof Type.Any>>(schema: T) =>
       Type.Unsafe<Static<T> | null>({ ...schema, nullable: true });
     ```
   - 导出后为 `"nullable": true`，Swift OpenAPI Generator 正确将其映射为 `Optional<T>`。
4. **Decimal 与货币/数值高精度防丢失**：
   - 业务模型中的数值（如身高 `heightCm`、体重 `weightKg`）在 HTTP 传输协议中统一使用**定点十进制字符串**（`string` + `description` 标注精度），避免在 JSON 浮点解析时发生精度抖动，Swift 端直接映射为 `String` 并由领域层转换为 `Decimal`。
5. **多态联合（Discriminator Union）在 OpenAPI 3.0.3 与 Swift 端的完美生成（transformOpenApi 转换器）**：
   - **问题**：TypeBox 原生 `Type.Union` 会输出内联 `anyOf`，导致 Swift OpenAPI Generator 退化为 `value1, value2` 结构体字段；若未配置 `mapping`，Swift 生成的代码会错误期待类型名（如 `FeedingEvent`）而非实际业务字段（如 `feeding`）。
   - **解决方式**：使用集中转换器 `transformOpenApi` 将 `anyOf` 转为 `oneOf` 与 `$ref`，并根据子模型的 enum 取值自动补全 `discriminator.mapping`：
     ```json
     "discriminator": {
       "propertyName": "kind",
       "mapping": {
         "feeding": "#/components/schemas/FeedingEvent",
         "diaper": "#/components/schemas/DiaperEvent",
         "sleep": "#/components/schemas/SleepEvent"
       }
     }
     ```
   - **收益**：Swift OpenAPI Generator 自动生成标准 Swift `enum TimelineEvent { case feeding(FeedingEvent), case diaper(DiaperEvent), case sleep(SleepEvent) }`，解码时自动根据 `kind` 精准匹配并构造枚举分支。
6. **Swift 客户端 Date 解码策略**：
   - RFC 3339 / ISO 8601 日期时间（`format: "date-time"`）在 Swift 原生端解码时，需确保传输转换器配置 `decoder.dateDecodingStrategy = .iso8601`，无缝反序列化为 `Foundation.Date`。

---

## 6. 干净 checkout 的复现顺序

以下命令在仓库根目录执行。Node 实验只使用 `scratch/boot01/package-lock.json`；基础设施 runner 每次创建自己的随机端口、临时目录和测试身份，完成 PG/Redis、Prisma 与 BullMQ 检查后自动清理，不接受持久化 `start`/`stop` 实例：

```bash
cd scratch/boot01
npm ci --ignore-scripts --no-audit --no-fund
npm run test:swagger
swift test --package-path swift-openapi-check
bash ./infra-test-env.sh run
```

`npm run backend:doctor` 只检查本机工具链，不启动服务；没有 Docker 的 Homebrew 本地 profile 会明确输出 warning，CI 可设置 `REQUIRE_DOCKER=1` 将其升级为失败。
