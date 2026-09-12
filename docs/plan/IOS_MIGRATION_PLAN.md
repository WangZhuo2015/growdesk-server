# Baby Panel 原生与后端重构：可执行计划入口

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


版本：3.0 / 2026-09-11。状态：**BOOT-01 和 IOS00 基线已完成本地复核，正推进后端工作区；联网应用、仅本机保存可选，云同步需授权。**

本版本替代上一次“保留服务端SQLite、优先MVP”的方案。新的目标是完整iPhone/iPad原生产品、独立后端与PostgreSQL，从首个正式版本就具备可靠同步、持久AI任务、权限隔离、可验证的数据迁移和性能基线。阶段化开发用于降低实现风险，不把未完成基础能力带入首发。

本计划已迁入 GrowDesk 独立服务端仓库。用户已创建服务端基础骨架（根 package/tsconfig、domain/database/contracts 三个包），iOS 仓库尚无工程；这些不代表任务已验收。本次只整理计划和开工入口，未安装依赖、运行迁移/压测或访问生产数据。旧 Web 审查基线为 ed7318d；开工必须重新确认各仓库 HEAD 和工作区状态。

最新产品决策见 [07 本地保存与按需云协作](implementation/07_LOCAL_FIRST_OPTIONAL_SYNC.md)，优先于下文旧的登录/缓存前提。此前的“未实施”段落为历史基线，当前进展以 evidence 报告为准。

账号与宝宝明确为多对多；家庭资格不能替代宝宝记录授权。关系、回填及逐宝宝权限以 [08](implementation/08_ACCOUNT_BABY_RELATIONSHIPS.md) 为准。

## 1. 推荐技术栈

| 部分 | 决策 |
|---|---|
| iPhone/iPad | Swift 6 + SwiftUI + Observation，最低系统暂定17 |
| 原生正式本地库/可选同步队列 | GRDB + SQLite；与服务器数据库用途不同 |
| 网络 | URLSession + Swift OpenAPI Generator；SSE补发事件 |
| API服务 | Node.js 24 LTS + TypeScript + Fastify 5，独立于Next.js |
| 主数据库 | PostgreSQL 18 + Prisma 7 + adapter-pg |
| 任务执行 | Redis 8 + BullMQ 5 + 独立worker；PostgreSQL保留任务事实/事件/outbox |
| 文件 | 私有S3对象存储，附件按用户/家庭鉴权 |
| 推送 | APNs + 兼容Web Push；通知内容与已读持久化 |
| 部署/观测 | OCI容器 + Caddy；Pino/OpenTelemetry/Prometheus/Grafana |

采用TypeScript保留现有领域规则和测试资产；用独立Fastify服务替换Next服务宿主。主要性能工作放在查询/索引、连接预算、队列背压和派生数据上，不假定换语言就能解决性能问题。版本和框架依据见[架构分册](implementation/01_ARCHITECTURE.md)。

生产不再运行SQLite。旧库作为只读迁移源；原生本地SQLite承担正式本地数据与用户选择开启的同步操作，这是长期设计而不是临时过渡。不采用双主数据库、长期双写、CloudKit第二权威或第一版后必需再换库的路线。

## 2. 实现规格包

请把以下文件随代码仓库一起交给实现Agent，不要只转述摘要。

| 文件 | 内容 | 谁在什么时候读 |
|---|---|---|
| [01 架构和技术决策](implementation/01_ARCHITECTURE.md) | 技术栈、目录、依赖、旧代码去向、权限/产品默认值 | 所有Agent首次开工 |
| [02 后端改造与协议](implementation/02_BACKEND_CONTRACTS.md) | auth/refresh、事务幂等、离线命令、游标/快照、AI run、S3、通知 | 后端/同步/原生联调；跨端协议权威 |
| [03 PostgreSQL迁移](implementation/03_DATABASE_MIGRATION.md) | 47个旧模型分类、类型/ID转换、ETL、附件对账、停写切换与回退 | 数据库Agent与迁移review |
| [04 功能对照和iOS任务](implementation/04_FEATURE_PARITY_AND_IOS.md) | 旧页面/API到原生的映射、模块边界、逐项实现和真机验收 | iOS/领域业务Agent |
| [05 性能、部署与验收](implementation/05_PERFORMANCE_DEPLOYMENT_ACCEPTANCE.md) | 容量目标、起测机器、负载/故障、CI、备份、SLO/RPO/RTO | 运维/性能Agent与最终review |
| [06 Agent执行手册](implementation/06_AGENT_EXECUTION_PLAYBOOK.md) | 任务卡、依赖、拟新增命令、证据模板、可复制实现/review提示词 | 每次领取任务 |
| [07 本地保存与可选同步](implementation/07_LOCAL_FIRST_OPTIONAL_SYNC.md) | 联网与数据上传分离、显式绑定、首次导入、暂停与在线能力 | 存储、同步、在线 AI |
| [08 账号与宝宝多对多](implementation/08_ACCOUNT_BABY_RELATIONSHIPS.md) | BabyMember、逐宝宝权限、邀请/撤销、迁移回填和 feed 过滤 | 账号、数据库、iOS 宝宝选择 |

所有新接口、脚本、表都是待实现项。文档中的示例不是生产可执行命令，特别是标注“拟新增”的npm脚本要先由对应任务实现。任务完成需关联commit、测试输出与review结论，不能靠修改文档状态代替实现。

## 3. 后端重点改造

1. **独立服务。** 在 growdesk-server 根工作区补齐服务端，把领域逻辑、数据库、供应商适配、API、worker分开。现有Web暂不搬目录，最终也访问同一个新后端。
2. **PostgreSQL模型。** 保留业务表与ID，转换日期/JSON/数值；增加版本、软删除、同步feed、设备会话、任务/事件、附件归属和通知；独立迁移历史。
3. **统一写事务。** 业务记录、快照、幂等结果、同步change和任务outbox同一事务，REST/MCP/AI调用同一服务。
4. **完整离线协议。** 日常记录和手动成长记录离线新增/修改/删除，冲突保留草稿；账号切换不能带着旧队列用新token发送。
5. **可靠同步游标。** 按家庭事务锁分配提交有序cursor；全量快照与增量追赶；删除和外部AI写入均能同步。
6. **持续任务。** 保存消息/run后返回202，独立worker执行，SSE展示进度；重连补发、租约/fencing、幂等工具、确认/取消、预算与恢复全部在首发前完成。
7. **权限与附件。** 设备刷新/撤销、多宝宝显式目标、家庭角色、私有文件；修复仅凭登录或目标ID访问的路径。
8. **生产运维。** 性能实测、数据库/附件备份恢复、故障注入、资源监控，以及不丢新写的切换/回退演练。

代码层已观察到的基础差距：当前登录主要发cookie；聊天绑定request.signal；OCR/语音存在进程内异步执行；outbox对全部4xx丢项；上传路由只有登录检查；Next、Prisma和业务耦合。这是静态代码事实，未声称已在线复现。

## 4. 容量与性能：先给可测目标

建议以如下规模验证第一版：**1万注册家庭、2000 DAU、1000同时在线（含200 SSE）、100 RPS业务API、1000万业务记录、单家庭5万记录**。它们是设计/压测目标，不是当前系统已证明的能力，也不是必须一次购买的生产资源。

05规定读写混合、热点家庭、冷/热缓存、SSE慢客户端、数据库查询和AI供应商等待的分离测量。参考起测配置是2个API进程各2vCPU/4GB、PG 4vCPU/16GB SSD、独立worker与Redis；真实资源选择以目标地区及压测结果定。

没有现网机器配置、监控与负载记录，无法诚实判断“现有性能足够”。新架构通过同技术栈增加API/worker副本、调整索引/聚合/连接预算扩容，不把缓存或框架宣传benchmark当成产品容量结论。

## 5. 实施顺序

| 门禁 | 交付 | 不通过时 |
|---|---|---|
| G1 基础 | 技术组合实验、隔离环境、契约生成、PG模型 | 先解决工具链/契约 |
| G2 数据可靠性 | 身份/家庭、统一事务、离线/增量协议 | 不接真实家庭数据，不放宽权限/冲突规则 |
| G3 持久任务 | 私有附件、AI/OCR/语音run、恢复与幂等工具 | 不用进程内Promise替代 |
| G4 后端完整 | 所有领域、MCP/OAuth、Web兼容 | 对照04逐项补齐 |
| G5 原生完整 | 所有既有功能、iPad、无障碍、真实API联调 | mock/UI截图不等于完成 |
| G6 发布候选 | 迁移对账、压测、故障、真机、备份/回退演练 | 不切生产 |
| G7 生产接受 | 停写迁移、单一新写权威、监测与恢复准备 | 按03/05处置，不直接倒回旧SQLite |

开发可并行：后端主线、基于冻结契约的原生、迁移/测试/运维。schema与契约各指定一个Owner，避免多个Agent同时修改核心协议。

完整范围初步按**20–32人周**预算，含实现、联调和复审返工，不含审核等待。之前MVP估算不再适用；这不是对Agent工时的承诺。完成BOOT-01/02、BE-01后，用实际任务耗时与返工率重新估算。

## 6. 给较弱Agent的交付方式

一次派一个任务，例如BE-05/feeding，同时给任务卡、相关协议章节、允许文件、已接受依赖、验收用例。不要让它自行解释“完成后端重构”这类大目标。

每次交付必须写evidence/tasks/<TASK-ID>/REPORT.md，附改动、命令/退出码、测试环境和证据；实现Agent只能标IMPLEMENTED_NOT_REVIEWED。独立review通过后才接受。06提供可复制的实现与review提示词。

优先让review投入G1/G2/G3/G6，以及跨租户、事务、同步、AI重试、数据库切换这些高代价错误。普通页面可先按同一设计组件和验收表完成，再批量review。

## 7. 现在可以直接开始什么

下一次明确下达实现任务时，从 **BOOT-01技术组合验证 → BOOT-02隔离工作区 → BE-01契约流水线** 开始，不要第一步复制所有页面成SwiftUI。

仍需在G1记录、但不妨碍当前方案细化的信息：家庭设备最低系统、是否有Android照护者、目标部署地区、现有服务器资源与预算、是否公开分发。默认继续支持现有账号/MCP与Web过渡入口，不新增支付/社交登录；provider/region在购买资源前确定，不改变已选栈。

首发底线：数据能正确迁、记录不丢不重、权限不串、AI任务可恢复、性能有实测证据、所有既有功能可用。
