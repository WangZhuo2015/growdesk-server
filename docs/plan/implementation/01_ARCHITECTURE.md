# 01 — 最终架构、决策与边界

> **2026-09-11 产品决策更新**：应用正常联网，可选择数据仅本机保存；云同步/协作需主动授权。涉及登录前置、仅缓存、本地保留和“必须联网”的规则以 [07 本地保存与按需云协作](07_LOCAL_FIRST_OPTIONAL_SYNC.md) 为准；云端事务、权限与幂等不变量继续有效。

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


日期：2026-09-11。状态：设计基线，未实施。本文取代旧方案中“服务端继续 SQLite”“先完成简化 MVP 再补基础能力”的建议。

## 1. 本次交付是什么

这是一套可交给实现 Agent 的工程规格，不是已验证的系统。现有代码证据来自旧 Web 参考仓库 `ed7318d`；本轮没有访问生产、安装服务、执行数据迁移或压测。新文件路径、接口、数据库表和命令均为待实现目标。项目开工时必须记录实际 HEAD 和差异；不能假定今后工作区一直不变。

目标是完整原生 iPhone/iPad 产品和独立服务端。开发按小切片验收，首次公开发布前必须完成全部基础能力与功能对照表。小切片是控制实现复杂度的方法，不是留下未完成数据一致性、权限或迁移工作的上线捷径。

“一步到位”定义为固定核心技术栈、数据权威和接口边界，避免计划内二次重写；它不意味着永不升级依赖、不做容量测试，或现在建设尚无需求的微服务平台。

## 2. 冻结的技术决定

| 决策 | 采用 | 明确不采用 / 原因 |
|---|---|---|
| 原生 UI | Swift 6、SwiftUI、Observation；UIKit 用于必要系统桥接 | 不用 WebView 包装，也不引入 Flutter/React Native 重写层 |
| 最低系统 | iOS/iPadOS 17，编译使用开工时稳定 Xcode 并锁定版本 | 不以新系统独占功能作为基础依赖；实际家庭设备不满足时，在开工门禁调整最低版本 |
| 本地数据库 | GRDB + SQLite；Repository 封装 | 这是可重建缓存与用户未同步操作存储，不是服务器数据库；不建 CloudKit 第二数据权威 |
| HTTP 客户端 | Swift OpenAPI Generator + URLSession；SSE 单独解析适配 | 不手写两套相互漂移的全部 DTO，不直接暴露 Prisma 模型给客户端 |
| 富文本/图表 | swift-markdown AST + SwiftUI renderer；Swift Charts | 原生覆盖AI表格/列表/代码块和成长曲线，禁止用单个Text丢掉旧Web报告结构 |
| 服务运行时 | Node.js 24 LTS + TypeScript strict | 不把成熟的 TS 领域规则全部改成 Go/Rust/Swift；I/O 密集的 API/LLM 工作首先受 DB、网络及供应商约束 |
| 服务框架 | Fastify 5，原生插件模块 + 构造函数/工厂注入 | 不继续用 Next.js Route Handler 承担目标业务服务；不引入 Nest 装饰器/容器层或微服务网络调用 |
| 契约 | TypeBox 路由 JSON Schema 单一源，`@fastify/swagger` 导出 OpenAPI **3.0.3** | 不维护手写 OpenAPI 和运行时校验两套规范；3.0.3 足够表达本项目，避免 3.1 转换器细节变成首轮不确定项 |
| 主数据库 | PostgreSQL **18** 当前稳定补丁版本，Prisma 7 + `@prisma/adapter-pg` + `pg` | 不继续服务端 SQLite，不直接暴露数据库给 App |
| 异步执行 | BullMQ 5 + Redis 8；任务事实、结果、重放依据存在 PostgreSQL | 不在 HTTP 中 `void asyncTask()`；不依赖 Redis 队列记录作为唯一任务凭证 |
| Redis 角色 | 专用队列实例，AOF、`noeviction`；另一个 Redis 实例做限流/短缓存 | 两实例相同技术栈；允许早期同主机，不共享驱逐策略，不让缓存淘汰任务 |
| 附件 | 私有 S3 对象存储，AWS SDK v3 的 S3 适配器 | 不放 Web `public/uploads`；不将 base64 嵌入数据库消息作为长期附件 |
| 推送 | APNs provider + 现有 Web Push 适配器 | 业务 notification 表是事实，推送仅提醒；不把推送送达等同于数据同步 |
| 部署 | Linux OCI 容器，复用 singbox nginx TLS/反向代理，API/worker/scheduler 独立进程 | 不为本规模引入 Kubernetes、服务网格、Kafka、Elasticsearch |
| 可观测性 | Pino 结构化脱敏日志、OpenTelemetry、Prometheus/Grafana | 不保存报告正文或 token 作为调试日志 |
| 构建/包管理 | 新服务端独立 npm lockfile + 现有 npm workspaces；iOS 使用 SPM | 沿用 npm，但不复制旧 Web 依赖锁；锁定实际兼容版本 |
| 测试 | TS `node:test`/tsx + Fastify inject + 隔离 PostgreSQL；k6；Swift Testing/XCTest/XCUITest | 不用 SQLite 模拟 PostgreSQL 行为；不拿单元通过代替故障和真机证据 |

Redis/BullMQ 的“至少一次”投递通过数据库幂等、任务租约 fencing 和事务 outbox 收敛为不重复产生业务记录。不能宣传所有外部副作用 exactly once。

固定 major 是工程基线，补丁和兼容插件版本在 `BOOT-01` 的兼容性实验后锁到 lockfile 和镜像 digest。实现 Agent 不得自行改核心选型；补丁安全升级正常进行。若组合不能通过实验，提交最小复现并先修正规格，不擅自换框架。

## 3. 为什么这样选后端

**保留 TypeScript 业务资产，替换服务宿主和数据库。** 当前 `lib/records/service.ts`、营养引擎、WHO 规则、疫苗调度、MCP 及 Agent 工具已积累校验与测试。重新用另一门语言写一遍，会把主要工作变成规则兼容排查，并不自动改善核心查询性能。

Fastify 的作用是把验证、序列化、认证和生命周期变成明确服务边界；选择它不构成任何“比当前快多少倍”的结论。CPU 密集的图像/音频处理进入独立 worker 进程；大表分页、索引、聚合、连接池和缓存由专项压测验证。LLM 请求等待在 worker 发生，不占数据库长事务，也不阻塞普通记录接口。

Prisma 保留领域开发效率；只允许数据库 package 中有必要的参数化 SQL，例如行锁、带条件 UPDATE、游标和批处理。禁止为了躲过类型检查把业务数据统一装入任意 JSON。服务端可以扩 API/worker 副本而不更换技术栈。

PostgreSQL 18 是已发布且仍支持的主版本；官方建议跟进当前小版本。选择 18 的依据是生命周期和成熟能力，不使用 beta。[PostgreSQL 版本策略](https://www.postgresql.org/support/versioning/)。Node 24 使用 LTS 线，Fastify 插件须通过组合验证。[Node 发布信息](https://github.com/nodejs/node/releases)、[Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/)。

## 4. 系统拓扑

```text
iPhone / iPad                            过渡 Web / OAuth 授权页面
SwiftUI → Repository → GRDB                         │
                  ↕ HTTPS                           │
                 nginx / 同源域名路由 / TLS
                            │
                Fastify API 副本（无状态）
           ┌────────────────┼────────────────┐
      HTTP v1         MCP / OAuth        旧 Web API 兼容层
           └────────────────┼────────────────┘
                      Domain Services
                            │
              PostgreSQL：业务、权限、事件、outbox
                            │
                     Outbox dispatcher
                            ↓
                  Redis(queue) / BullMQ
                            ↓
                 独立 AI/OCR/语音/通知 worker
                       │          │
                 模型供应商     私有 S3 / APNs

Redis(cache)：限流、可失效的热点缓存、事件唤醒提示
PostgreSQL：最终事实与重建来源；Redis 失效不得丢掉已接受的业务任务
```

AI 文本通过 SSE 读取已持久化事件。Redis Pub/Sub 可唤醒各 API 实例，但事件补发仍查 PostgreSQL；不能要求客户端连接恰好落到创建任务的实例。

## 5. 目录与依赖规则

三个目标是同级独立 Git 仓库。旧 Web 保留为迁移参考和后续兼容入口；下列为目标布局，用户已创建的文件必须保留并逐项验证：

```text
growdesk-server/
  apps/
    api/src/           # Fastify bootstrap、plugins、routes/v1、compat、mcp、oauth
    worker/src/        # BullMQ processors；独立 ai/media/notification 入口
    scheduler/src/     # durable outbox dispatch、reconcile、reminder scan
  packages/
    domain/src/        # Principal、services、policies、ports、纯规则
    database/src/      # Prisma client、repositories、UnitOfWork、locks
    contracts/src/     # TypeBox 请求/响应/错误/Event schemas
    adapters/src/      # S3、AI provider、APNs、Redis、clock、ID 工厂
    testkit/src/       # 隔离租户、fake provider、fixture、assertions
  prisma/
    schema.prisma
    migrations/        # 全新 PostgreSQL 历史
  contracts/openapi.json
  scripts/             # 隔离runner、迁移ETL、验证、压测初始化
  tests/               # unit、integration、contract、chaos、load
  infra/               # compose、nginx、monitoring、部署模板
growdesk-ios/
  BabyPanel.xcodeproj
  BabyPanel/           # App、Features、Core、DesignSystem
  BabyPanelTests/
  BabyPanelUITests/
  Contracts/           # 固定版本的 OpenAPI 快照及来源元数据
growdesk-android/       # 独立仓库，本计划不含 Android 实现任务
# 完整计划：growdesk-server/docs/plan/；各仓库 evidence/ 保存各自脱敏证据
```

单向依赖：`apps → domain + database + adapters + contracts`；`database/adapters → domain ports`；`domain` 不导入 Next/Fastify/Prisma/Redis；`contracts` 不导入 database；iOS 只依赖网络契约。编写架构测试阻止反向导入和 `any` 跨层蔓延。

不逐表创建空洞的 CRUD Service。以用例组织：RecordService、FamilyService、NutritionService、MedicalService、AiRunService 等，共享 UnitOfWork 保障一次业务操作的所有写入处于同一事务。HTTP、MCP、AI 均调用同一用例。

## 6. 旧代码如何迁，不仅是复制

| 现有来源 | 目标 | 必须做的处理 |
|---|---|---|
| `lib/records/service.ts` | domain/records + database repositories | 移除全局 prisma；注入事务/clock；时间区间明确；通知写 outbox；覆盖增删改恢复 |
| `lib/nutrition/*`、WHO、vaccine、age/date | domain 对应纯规则模块 | 共用 golden fixtures；保留旧值含义，修复规则必须独立标注，不偷偷改历史计算 |
| `lib/auth.ts`、`lib/api-helpers.ts` | auth plugin + principal/policies | 移除 cookie 隐式身份；显式设备会话/撤销/audience；家庭权限在写事务中复核 |
| `lib/agent/run.ts`、`model.ts` | provider adapter + worker | 保留模型协议适配；加入 run、step、usage、取消、预算、超时、恢复 |
| `lib/agent/tools.ts`、`lib/agent/tools/*` | domain tools → services | 消除直接跨租户按 ID 写；禁止绕过幂等、snapshot、change feed |
| `lib/mcp/*`、`lib/oauth/*` | API mcp/oauth adapter | 保持外部路径和协议；校验 scope 不扩大、单次 code、撤销；迁移后的 ID 仍可对应 |
| `lib/upload.ts`、`archive.ts` | attachment service + S3 | 所有对象有归属；旧无主归档隔离待处理，不自动公开 |
| `lib/push-helper.ts`、通知 storage | notification service + workers | inbox/已读服务器持久化、设备管理、投递去重 |
| `app/api/*` | v1 routes 和 compat routes | routes 只做协议转换，不保留第二套独立写逻辑 |
| 旧 tests | golden + 新 PG integration | 抽取测试意图，重写隔离环境；不能只改连接字符串然后宣称全通过 |

检查清单必须包含 REST/MCP/AI 三条路径：修复 REST 不代表工具路径已修复。现有医疗删除、附件读权限、OAuth refresh scope 等疑似缺口，开工基线任务先写最小隔离复现再修复；未经测试不要把子代理静态发现当成线上漏洞验证。

## 7. 数据所有权、权限与隐私决定

- 家庭拥有共享照护记录；User 拥有登录身份、设备会话、私人 AI 会话与个人通知状态。所有业务记录有 familyId、babyId、actorId/source（适用时）及 version。
- 角色固定 `admin/member/viewer`；现有 member 迁为 member，admin 保留。member 可记录和编辑共享照护记录；仅 admin 管理成员/邀请码/家庭删除。viewer 只读。任何权限扩展必须改矩阵及测试。
- AI 会话默认仅提问者可读；它产生且经允许的照护记录属于家庭。不能把私人聊天全文混入家庭 change feed。
- 私人 AI 附件由个人授权；病历确认入家庭后显式转为家庭资源，并建立引用。不能用一张“登录即可访问”通用文件路由。
- 第一版正式实现账号删除/导出。非最后成员删除账号：删除私人数据与凭据，共享记录保留并将作者匿名化；最后 admin 必须先转交或显式选择删除家庭，不能静默留下不可管理家庭。
- 家庭删除用状态机阻止新写，撤销权限，后台删关联内容/对象并可查询进度；备份中的数据按留存自然淘汰，恢复流程重放删除账本以防数据复活。具体留存对用户可见。
- 数据库权限通过 runtime 非所有者账号、显式 principal + scoped repository、复合外键及跨家庭负向测试实现。不在第一版额外引入未设计好的 RLS 策略；如以后启用，属于增加防线，不改变接口和数据权威。

## 8. 已定业务默认值

这些是可执行的默认规格，非必须先问用户才能写代码的空白项。若与实际需求冲突，在首个设计门禁统一修改，禁止各 Agent 分别猜测。

| 项 | 默认 |
|---|---|
| 发布目标 | 全功能 iPhone + iPad；Web 保留可用过渡入口；MCP 继续可用 |
| 登录 | 原有用户名密码 + 首方设备会话；不新增社交登录/收费体系 |
| 家庭时区 | 新建默认设备 IANA 时区并由用户确认；旧记录按迁移确认的 Asia/Shanghai 解释无时区数据 |
| 离线 | 日常记录及生长手动记录创建/编辑/软删除；最长自动重放 30 天，超过保留为待确认草稿 |
| 在线要求 | 成员/账号/权限变更、医疗/OCR确认、AI调用、补剂方案/奶粉档案修改与破坏性批处理 |
| Sync feed | 家庭与用户独立 feed；至少 90 天可补发；大于窗口用快照重建 |
| AI 写入 | 手动 App 聊天生成的结构化写操作先预览确认；外部 MCP 遵循显式授权 scope，可直接执行已授权工具，仍须审计 |
| 通知 | 锁屏默认通用文案；服务端 inbox，关闭推送仍可使用 |
| 数据地域 | 开发只用本地隔离资源；生产 provider/region 由运营地区决定，在购买资源前填部署清单，技术栈不变 |

不把 HealthKit、Watch、订阅、离线 LLM、复杂多宝宝对比和全新医疗功能混入本次完整迁移；它们不是当前功能欠账。App Intents/Widget/Live Activity 是明确的可选新功能，不阻塞旧功能完整迁移。

## 9. 规格优先级与变更控制

优先级：用户最新决定 > 适用 AGENTS 安全边界 > `02_BACKEND_CONTRACTS` 的协议/事务不变量 > 数据迁移/功能/运维分册 > 单项任务提示词。发现冲突必须改文档再继续依赖工作，不能边做边形成两种协议。

任何修改以下事项必须触发架构 review：数据库/provider、认证语义、角色权限、离线冲突策略、cursor语义、ID格式、任务幂等和重试、删除与留存、公开API破坏性变更。普通UI布局、模块内重构、补充测试不必重复请求架构决策。

资料：[Fastify 路由 schema](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[Swagger 插件](https://github.com/fastify/fastify-swagger)、[Prisma 连接池](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections)、[BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs)、[BullMQ 生产配置](https://docs.bullmq.io/guide/going-to-production)、[Swift OpenAPI](https://www.swift.org/openapi/)、[GRDB](https://github.com/groue/GRDB.swift)。

## 2026-09-12 部署入口调整

按用户决定，新服务先部署到 ubuntu@161.33.201.230，使用独立端口并复用既有 singbox nginx，不启动第二个入口代理，不影响原有服务。本节覆盖其他早期计划中的 Caddy 产品选型；TLS、SSE、私有存储、健康门禁、回滚与性能验收要求仍然有效，应转换成 nginx 的等价部署验证。当前只准备基础运行栈，不能把健康接口通过当成业务 API 已可上线。执行步骤以 deploy/HOST_RUNBOOK.zh-CN.md 为准。
