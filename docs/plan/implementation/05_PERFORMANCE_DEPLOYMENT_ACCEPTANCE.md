# Baby Panel 长期性能、部署与验收规划

> **2026-09-11 产品决策更新**：应用正常联网，可选择数据仅本机保存；云同步/协作需主动授权。涉及登录前置、仅缓存、本地保留和“必须联网”的规则以 [07 本地保存与按需云协作](07_LOCAL_FIRST_OPTIONAL_SYNC.md) 为准；云端事务、权限与幂等不变量继续有效。

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


**日期：** 2026-09-11
**状态：** 规划基线，尚未代表目标架构已实现或容量已通过
**适用范围：** Baby Panel 服务端、异步任务、私有对象存储、SwiftUI 客户端和发布运维
**相关文档：** `02_BACKEND_CONTRACTS`（业务协议和 API 字段的唯一参考）

## 1. 目的、边界与当前基线

本文件定义一个可长期运行、可复现实测、可由较弱 Agent 执行并由更强 Agent 独立复核的目标。它是**全功能首发前的长期门槛**，不是“抢一个 MVP”的实现清单，也不是当前系统已经具备容量的声明。任何机器数量、CPU、内存和吞吐数字，首先都是**起测预算**；只有在指定版本、数据规模、拓扑和脚本下复现并保存原始证据后，才能说该配置通过了本文件的目标。

本文件不展开业务协议、字段、错误码和资源路径。服务端协议按 `02_BACKEND_CONTRACTS` 设计；本文件只规定协议在容量、可靠性、部署和验证层面的约束。当前仓库的只读检查显示，代码基线仍是 Next.js 16、Prisma 7 `@prisma/adapter-libsql`、SQLite、Node 20 和单个应用容器；当前 `docker-compose.yml` 将 SQLite 数据放在应用卷中，CI 也以 Node 20 和 SQLite fresh database 为主。现有 `scripts/backup-db.sh`、`scripts/restore-db.sh` 也是 SQLite 专用。它们是迁移输入和差距证据，不能被当作目标 PostgreSQL 备份、容量或部署证据。

长期目标固定为：

| 层 | 目标选择 | 验收边界 |
|---|---|---|
| 运行时 | Node 24 LTS、TypeScript、Fastify 5 | 镜像、开发环境、CI、loadgen 脚本统一锁定 Node 24 的具体 patch；Fastify API 不与 Next.js 生命周期混用 |
| ORM/数据库 | Prisma 7 + `@prisma/adapter-pg`，PostgreSQL 18 | Prisma migration 是唯一生产 schema 变更入口；连接池由 `pg`/adapter 统一管理 |
| 队列与缓存 | Redis 8、BullMQ 5；queue 与 cache/rate 两个独立实例 | queue 数据必须可恢复且不得被缓存淘汰；AI/长任务在 worker 进程执行 |
| 对象 | S3 私有对象 | bucket、对象和路径均默认私有；对象 GET 经受保护 API 流代理，短时签名 URL 只用于上传，不把公网对象 URL 当权限控制 |
| 客户端 | SwiftUI iPhone/iPad | 客户端可以断开、重连、恢复任务和 SSE 游标；后台常驻不是服务端任务可靠性的前提 |
| 进程与入口 | API、worker、scheduler/dispatcher 分进程、分容器；Caddy TLS/反代入口 | API 不在 HTTP handler 内启动长期任务；生产直接访问 API/数据库/Redis 的端口关闭 |
| 编排 | Docker Compose 或等价单机/少量主机编排 | 不引入 Kubernetes；缩放由明确的 Compose service、主机资源和连接池预算控制 |

### 1.1 必须持续成立的安全约束

所有单元、集成、E2E、压力和恢复演练数据都必须使用以 `test_` 或 `e2e_` 开头的用户、家庭、宝宝，以及带本次 run label 的显示标签和 resource manifest，并写入独立 PostgreSQL 数据库。协议中的 `commandId`、`jobId` 等 UUID 和幂等键必须继续符合 02 的 wire 格式，不得为了测试强行加 `test_` 前缀；run manifest 将它们映射回测试数据库和 run label。测试进程发现 `DATABASE_URL` 是 SQLite、生产数据库或未带测试前缀的数据库名时必须直接失败。测试套件不再创建或使用 `dev_test.db`、`dev.db` 或任何 SQLite 文件。

压力数据必须使用独立的 PostgreSQL cluster/database，名称例如 `test_load_<run_id>`；E2E 使用单独的 `e2e_<run_id>` database。测试结束后只允许由隔离 runner 删除本次创建且通过 allowlist、owner、当前 cluster/database 身份和 run manifest 四项核验的数据库；不能把“名字带前缀”作为唯一删除条件。任何生产连接串、AI key、JWT secret、S3 secret 和真实家庭正文都不进入 loadgen 日志、CI artifact 或文档。

## 2. 目标拓扑

```text
SwiftUI / Web client
          │ HTTPS
          ▼
      Caddy（TLS、反代、连接上限、SSE、访问日志）
          │ private network
          ▼
   Fastify API container ×2 ───── PostgreSQL 18
          │       │                  │
          │       ├──────────────────┘
          │       ├──── Redis 8 / BullMQ 5（dedicated queue、事件）
          │       ├──── Redis 8（cache/rate，独立、可驱逐）
          │       └──── S3 private bucket（上传、附件、结果对象）
          │
   BullMQ worker container(s) ── PostgreSQL / Redis / S3 / AI provider
   scheduler/dispatcher container ── PostgreSQL / Redis

   独立 loadgen 主机 ──────────── Caddy 公网入口或隔离测试入口
```

API 固定为两个副本，每个副本 2 vCPU/4 GB；API、worker、scheduler/dispatcher 使用同一份版本化领域服务与 Prisma schema，但必须是不同的进程入口、容器、资源限制、日志标签和优雅退出流程。scheduler/dispatcher 不得可选地塞回 worker 容器。API 只负责认证、同步业务事务、返回已提交结果、建立 SSE；worker 负责从 BullMQ 领取任务、续租、调用 provider、保存结果并发出事件；scheduler/dispatcher 只负责定时扫描和派送。worker 重启不会依赖调用请求仍然存在。

PostgreSQL 中的 `TaskExecution` 是通知、snapshot/export/delete、AI 等所有异步任务的公共执行头和事实源，保存状态、租约、fencing token、重试次数、结果引用和审计时间；本文件沿用 `Task/Run` 作为协议简称。`AiRun` 与 `TaskExecution` 一对一，只保存 AI context/model 等 AI 专属字段，不复制 status/lease。BullMQ 是派送、唤醒和并发执行层，队列丢失时可以根据 PostgreSQL 的事实重建。scheduler/dispatcher 每 1 秒只扫描 `TaskOutbox` 到期项，并使用独立的 outbox dispatch lease 派送；它不能领取 `TaskExecution`、设置业务 lease 或 fencing token。worker 在数据库事务中领取 `TaskExecution`，设置 60 秒业务 lease、15 秒 heartbeat 并递增 fencing token；reconciliation 每 30 秒对账 queued/running/terminal 状态。旧 worker 即使恢复也不能覆盖新 owner 的终态。

SSE 连接不能长时间持有 PostgreSQL client；连接只在读取游标、校验权限和写入事件时短暂借用。服务端每 15 秒发送 heartbeat；每客户端发送缓冲上限 64 KiB，超过上限就断开并要求客户端按游标重连，不能在内存中无限堆积。事件以“最多 200 ms 或累计 2 KiB”批量从已写入 PostgreSQL 的事件/Task 状态后再推给客户端，先持久化后推送。Caddy 必须显式验证 SSE 的 flush、idle timeout、keep-alive、Last-Event-ID/游标转发和断开回收。健康检查分为进程存活、核心可接流量和依赖详情三层：live 只证明进程能响应；core ready 只要求 PostgreSQL 连接、迁移 schema 版本和 auth secret 可用；Redis queue/cache/rate 或 S3 降级时，health 详情必须标记 `degraded` 并说明受影响 feature，不能令普通记录 API 整体 unready。任务派送可返回可重试的 503 或已持久化的 `queued`，对象上传/finalize/受保护对象 GET 可按功能返回 503；普通已提交记录读写继续服务。

API、worker、PostgreSQL、Redis、Caddy 和 loadgen 的网络边界、镜像 digest、环境变量名称、日志保留期和 secret 注入方式写入 `compose.production.yaml`、`compose.test.yaml` 与部署 runbook。生产环境不使用 `.env.test`；CI 不读取生产 `.env`。

## 3. 长期容量目标与测试解释

下表是本计划要验证的目标负载，不是从当前代码推导出的结果。

| 目标 | 测试定义 | 解释 |
|---|---|---|
| 注册家庭 | 10,000 个 | 用于验证租户索引、授权查询、家庭/宝宝列表和数据分布；不等同于 10,000 个同时活跃家庭 |
| DAU | 2,000 个合成活跃用户 | 由 k6 场景按高峰时间分布登录、浏览和写入；DAU 是日规模，不直接换算成恒定 RPS |
| 在线连接 | 1,000 个并发连接 | 其中 200 个保持 SSE；其余执行间歇性 REST、重连和前台切换行为 |
| REST 吞吐 | 稳态 100 RPS，80% 读/20% 写 | 只计算业务 REST；2 倍冲击为 200 RPS，按 endpoint tag 分桶 |
| 业务记录 | 总计 10,000,000 条 | 覆盖时间线、分页、筛选、授权和聚合查询；生成器记录每类记录数量和校验摘要 |
| 单家上限 | 至少一个家庭 50,000 条记录 | 验证最坏租户的 keyset 分页、聚合、索引和缓存，不允许用平均家庭掩盖慢租户 |
| 任务 | mock AI 主测试，真实 AI 另行小配额 | provider 延迟、限额、重试和模型波动不混入核心 REST 门槛 |

10,000 家庭、2,000 DAU、1,000 在线和 100 RPS 是四个不同维度。100 RPS 是高峰容量目标，不声称它是 2,000 DAU 的日平均行为。数据生成器应使用长尾分布：少量重家庭达到 50,000 条，中等家庭和轻量家庭共同组成 10,000,000 条，并在 manifest 中写出精确分布，避免只测均匀数据。

## 4. 可复现实测方案

### 4.1 起测资源和版本

| 组件 | 起测预算 | 初始运行约束 |
|---|---:|---|
| API ×2 | 每个 2 vCPU、4 GB RAM；合计 4 vCPU、8 GB | 固定两个副本；每副本 CPU 稳态目标不超过 65%，2 倍冲击观察峰值不超过 85%，RSS 保留至少 25% 余量 |
| PostgreSQL 18 | 4 vCPU、16 GB RAM、SSD | `max_connections=100`；启用 WAL、统计和慢查询采样；磁盘空间按 10M 记录、索引、WAL、备份和增长余量预留 |
| Redis 8 queue | 1.5 GB 起测预算（Redis 总预算的一部分） | dedicated queue，`maxmemory-policy=noeviction`、AOF；监控 `used_memory`, `blocked_clients`, `evicted_keys` 和 AOF 延迟 |
| Redis 8 cache/rate | 0.5 GB 起测预算（独立实例） | 只放可重建 cache、rate limit 和短 TTL 数据；允许驱逐，禁止写入 BullMQ key |
| worker | 4 vCPU、8 GB RAM | BullMQ concurrency 由实测调节；CPU/内存超限必须导致可见告警，不静默 OOM |
| scheduler/dispatcher | 1 vCPU、1 GB RAM | 独立进程/容器；只持有 outbox dispatch lease，不领取 TaskExecution 业务 lease |
| Caddy | 1 vCPU、1 GB RAM 起测预算 | TLS、SSE 连接、访问日志和 upstream health check 一并测；不让 Caddy 成为未观测瓶颈 |
| 独立 loadgen | 至少 4 vCPU、8 GB RAM | 与被测服务分机/分网络；先证明 loadgen CPU、网络和 socket 没有饱和 |

Redis 两个实例合计按 2 GB 作为起测预算，初始拆为 queue 1.5 GB、cache/rate 0.5 GB；这只是第一组可复现的内存分配，不能据此承诺长期队列容量。

上述数字只保证“从这个预算开始测”。它们不是生产实例数、HA 保证、云厂商规格承诺或线性扩容公式。最终报告必须写明 CPU 型号/云实例、磁盘类型、镜像 digest、Git SHA、Node/Fastify/Prisma/PG/Redis/BullMQ/k6/Caddy patch、内核、时区、NTP、配置文件 hash 和数据库统计信息。

### 4.2 测试数据库和合成数据

1. 隔离 runner 只为本次运行创建 PostgreSQL database，例如 `test_load_20260911_<run_id>`，数据库 owner、应用 role、迁移 role 和只读观测 role 分离。runner 同时保存创建凭据的安全指纹、cluster/database 身份、owner、run manifest 和 allowlist；只有同一 runner 能清理该库。
2. 使用 `npm run backend:db:test:migrate -- --run-id <id>` 建立 schema；禁止 `db push` 作为容量环境初始化。迁移完成后记录 migration table、schema hash 和 `ANALYZE` 时间。
3. 运行 `npm run backend:load:seed -- --profile target --run-id <id>` 生成 10,000 家庭、2,000 以上 DAU 用户、至少一个 50,000 条记录家庭和总量 10,000,000 条。用户名、家庭名、宝宝名使用 `test_`/`e2e_` 前缀；显示标签和 resource manifest 带 `test_load_<run_id>`；command/job UUID 和 idempotency key 保持协议格式，由 manifest 关联 run label。生成器输出 row count、每租户最大值和 hash，不输出正文。
4. S3 使用隔离 bucket 或隔离 prefix，并开启私有访问、对象版本/校验和及自动清理生命周期。医疗、附件和结果对象的 GET 必须经过受保护 API 做租户授权并流式代理；短 TTL 签名 URL 只用于受授权的上传（含 multipart/finalize），不得用公网 URL 或签名 read URL 暴露对象。用合成图片/音频，禁止上传真实病历。
5. Redis queue 与 cache/rate 使用两个独立 Redis 8 实例；queue instance 为 dedicated `noeviction` + AOF，cache/rate instance 才允许驱逐。压测结束先导出两套实例的 memory/queue 统计，再删除隔离资源。
6. 启动前执行跨租户越权 smoke、幂等写入 smoke、数据库连接串 guard、`/health/ready` core status 和依赖详情检查。核心 PG/schema/auth 不通过不能进入正式负载；Redis/S3 的 `degraded` 只允许把对应 queue、rate、上传或对象 GET 场景标为 503/queued 并阻断该 feature 的目标结论，不能令普通记录 API 整体下线。

建议命令（实现后统一写入 06 定义的 `backend:*` package scripts；隔离 runner 注入连接串并负责唯一创建/清理，连接串只在 CI secret/本地安全环境提供）：

```bash
RUN_ID="test_load_${CI_RUN_ID:-local}_$(date +%Y%m%d%H%M%S)"
npm run backend:test:guard -- --run-id "${RUN_ID}"
npm run backend:db:test:migrate -- --run-id "${RUN_ID}"
npm run backend:load:seed -- --profile target --run-id "${RUN_ID}" \
  --families 10000 --records 10000000 --max-records-per-family 50000 \
  --label-prefix "${RUN_ID}_" --resource-manifest "artifacts/${RUN_ID}.resources.json"
npm run backend:evidence:check -- --task OPS06 --run-id "${RUN_ID}"
npm run backend:load:test -- --profile target --run-id "${RUN_ID}"
npm run backend:evidence:check -- --task OPS09 --run-id "${RUN_ID}"
```

隔离 runner 必须在成功、失败、中断和超时路径都执行清理；清理前再次核对 run manifest、database owner、当前 cluster/database 身份和 allowlist，清理后保存 drop/audit artifact。普通 shell、默认主机上的数据库客户端和手写连接串不能创建或删除测试库。

### 4.3 k6 场景和时序

k6 使用 `constant-arrival-rate`/`ramping-arrival-rate` 表达 REST 到达率，并负责 800 个并发普通 session；200 个 SSE 由独立 Node 24 `fetch`/`ReadableStream` SSE harness 建立、解析、断开、重连和补游标，不能假定 k6 原生 SSE API。两套 harness 使用同一个 `run_id`、阶段 barrier、单调时钟和 wall-clock 时间戳同步热身/稳态/冲击/浸泡，分别输出原始事件和汇总，最终由 runner 对齐窗口。合计在线连接仍为 1,000，REST 总到达率仍为 100 RPS（2 倍阶段 200 RPS）。每个请求标记 `scenario`, `endpoint_class`, `read_write`, `tenant_shape`, `ai_mode` 和 `expected_response`。不要让一个默认 `http_req_duration` 混合 REST、SSE 长连接和 AI provider。

100 RPS 稳态的固定组成也写入 load manifest：读 80 RPS 分为 timeline 25、sync 20、nutrition 12、growth 10、me 8、runstate 5；写 20 RPS 分为普通记录 15、AI run create 3、attachment finalize 1、notification/read receipt 1。`notification/read receipt` 属于写入确认类 endpoint，若实现拆成通知读取和已读写入，仍须在报告中分别标记并保持总量 1 RPS。每个阶段都按这份组成限流和验收，不能只报告总 RPS。

一次完整运行按以下时间执行：

| 阶段 | 时长 | 负载 | 目的 |
|---|---:|---|---|
| 热身 | 10 分钟 | 从低速平滑升到 100 RPS、建立 1,000 在线连接和 200 SSE | 填充连接池、缓存、JIT、Redis queue 和 PostgreSQL buffer；不取热身百分位作结论 |
| 稳态 | 30 分钟 | 100 RPS，80% 读/20% 写，1,000 在线 | 核心 P95/P99、错误率、资源和计划门槛 |
| 2 倍冲击 | 10 分钟 | 200 RPS；连接和 SSE 保持可观察，必要时另设 spike tag | 验证排队、限流、错误恢复和 backpressure，不把短时超载当成稳定容量 |
| 浸泡 | 2 小时 | 回到 100 RPS，保持 1,000 在线 | 首 10 分钟同时作为冲击后的恢复窗口；观察内存、连接泄漏、队列、WAL、VACUUM 和长尾漂移 |

正式结果至少跑三次，保持同一镜像、数据 manifest 和配置 hash。最终报告同时给出每次原始结果、中位数、最差值和差异解释；一次“漂亮”的运行不能覆盖另一次失败。loadgen 自身 CPU、网络、FD、临时文件和 dropped iterations 必须低于 70% 起测预算。

主测试将 provider 替换为本地固定 8 秒延迟、固定响应和固定错误比例的 mock；目标 AI 到达/完成速率为稳定 3 task/s，因此 provider/worker 的在途并发至少为 `3 × 8 = 24`，并在报告中记录实际 queue concurrency。24 是避免 mock 服务自身形成假瓶颈的下限，最终 BullMQ concurrency 仍由 worker CPU/RAM、PG pool 和队列 lag 实测决定，不能脱离预算硬编码。mock 只能模拟 provider 接口，不改变任务提交、落库、重试和事件流程。另跑真实 AI 小配额场景：固定合成 prompt、严格预算、独立 `ai_mode=real` 标签和单独账单/限额；真实 provider 的网络、排队、限流和模型延迟只用于 AI 报告，不改变核心 REST 的通过/失败结论。

### 4.4 指标、分桶和门槛

核心 REST 的延迟定义为从 loadgen 发出请求到收到完整 HTTP 响应，另记录 Caddy、API handler、数据库、Redis 和内部序列化分段。业务 REST 不包含 provider 等待。SSE 使用“连接建立延迟”和“事件产生到客户端收到的 fan-out 延迟”两套指标；一条持续两小时的连接不能把请求持续时间拿来与 REST P99 比较。

| 类别 | 稳态门槛 | 2 倍冲击/恢复门槛 | 计入方式 |
|---|---|---|---|
| REST 读 | P95 ≤ 250 ms；P99 ≤ 500 ms | P95 ≤ 600 ms；回到稳态门槛 ≤ 10 分钟 | 按 endpoint、分页类型、租户形状分桶 |
| REST 写 | P95 ≤ 400 ms；P99 ≤ 800 ms | P95 ≤ 1,000 ms；无已提交写丢失，≤ 10 分钟恢复 | 2xx 表示事务已提交；4xx/5xx、连接断开或超时若事务结果未知，必须用同一幂等键查询，不能按状态码断言未提交 |
| REST 服务端错误 | 5xx/timeout ≤ 0.1% | ≤ 1%，且无持续增长 | 401/403/409/429 另列；不能把业务拒绝藏进成功率 |
| SSE 建立 | P95 ≤ 1 s；P99 ≤ 2 s | 新连接不因旧连接泄漏而失败 | 200 个并发连接单独统计 |
| SSE 事件 | fan-out P95 ≤ 2 s；P99 ≤ 5 s | 断开后重连并补游标，丢事件数为 0 | 客户端主动关闭、网络断开单列 |
| TaskExecution/worker queue | 任务入队确认 P95 ≤ 500 ms；outbox dispatcher lag P99 ≤ 2 s；mock 任务开始 P99 ≤ 30 s | backlog 在恢复窗口内下降，失败任务有可见状态；60s lease + 30s reconciliation + 1s dispatch 后替代任务进入 running 目标 ≤121s | provider 时间单独记录；provider unknown 单列 |
| 数据库热查询 | P95 ≤ 50 ms；P99 ≤ 150 ms | 无持续锁等待、死锁或连接耗尽 | 以 driver/应用 instrumentation histogram 或采样的原始 query timing 计算；`pg_stat_statements` 只复核聚合量、query identity 和计划候选 |
| Redis | queue command error = 0；`evicted_keys` = 0 | restart/AOF 恢复后队列可继续消费 | cache miss/SET 拒绝单列，不能驱逐 queue |
| 资源 | API/worker/PG CPU 稳态 ≤ 70%；RSS ≤ 75%；无 OOM/swap | 峰值 ≤ 85%，恢复后回落 | 采样不得只看容器瞬时快照 |

错误率的分母、排除项和采样时间必须写入报告。客户端取消、预期 401/403、并发冲突 409、限流 429 不归入 5xx，但必须报告其计数和原因。网络重试不能静默掩盖首次失败；k6 的 `http_req_failed`、应用 request log 和数据库提交计数要能相互对账。明确返回的业务拒绝只有在事务确认未提交时才可标记 `rejected`；5xx、连接断开和 timeout 可能发生在 commit 前后，属于 `unknown`，必须按同一 command/idempotency key 查询最终状态。结果未知时禁止自动生成第二个业务副作用。

provider 延迟永远单列：`provider_request_ms`、provider status、任务从 `queued` 到 `running`、从 `running` 到最终落库，以及总的用户可见完成时间。mock AI 只用于证明本系统的排队/落库/重试；真实 AI 结果不能被用来证明 PostgreSQL、Caddy 或 SwiftUI REST 的 P99。数据库 P95/P99 必须来自请求/查询级 histogram 或保留的原始 timing 样本；`pg_stat_statements` 的累计统计不能直接当百分位数。

## 5. 性能工程预算

### 5.1 PostgreSQL 连接池

基准 PostgreSQL 的硬上限为 100 个连接，预算固定为：**70 个应用连接、20 个扩展/故障预留、10 个运维/迁移/观测连接**。应用池总和不能超过 70；如果 API 有 `N` 个副本，则 API 每副本的 pool 上限、worker pool 和迁移工具必须按副本数重新计算，不能每个容器都设置 70。

起测建议为 API 总池 50、即两个 API 副本各 25；worker 总池 14；独立 scheduler/dispatcher role 总池 6，应用合计正好 70。scheduler/dispatcher 不得与 worker 共容器或另开隐含连接池；每个 role 只使用登记的 pool。SSE 不占住连接；单请求查询结束立即归还。事务 API 用较短的 acquire/query/lock timeout，超时返回可重试的可见错误，不无限等待。禁止按请求创建 `Pool`，禁止创建多个未登记的 Prisma client。应用启动时打印脱敏后的 pool budget、max/idle/timeout 和 process role；运行时监控 active、idle、waiting、timeouts，并由 CI/启动 guard 断言两个 API `25 + 25`、worker `14`、scheduler/dispatcher `6` 的总和不超过 70。

20 个预留连接用于故障切换、临时扩容、回滚前核验和后台重建；10 个运维连接给迁移、backup、restore、`EXPLAIN`、监控和管理员。若需要在线迁移，必须先在预算表中登记它占用的连接并从相应池释放，不能在 100 上限之外“临时再开一池”。

### 5.2 查询、索引、分页和聚合

目标 schema 要把高频时间线从字符串迁移为可比较的 `timestamptz`/明确日期类型，并为每个主要查询形状建立组合索引。候选索引需经真实 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 和选择性数据验证后落 migration，不以“看起来有索引”作为通过条件。常见形状包括：

- 以 `baby_id` 加事件时间倒序、稳定 `id` 作为 keyset 游标；
- 同步增量使用 `FamilyChange` 的 `(family_id, cursor)` 组合索引和高水位游标；`updated_at` 不是增量同步顺序，不能用它替代 cursor（非同步审计查询需要时另建索引）；
- 幂等键的唯一约束和任务状态/租约的部分索引；
- 过滤维度与时间范围的组合索引，避免全表排序；
- 聚合所需的 covering/index-only 访问，但要衡量写放大和 vacuum 代价。

所有时间线、历史和任务列表使用 keyset/cursor 分页，禁止默认 `OFFSET` 扫描 50,000 条重家庭。日汇总、成长趋势和通知计数应有明确的预聚合、增量表或缓存失效策略；缓存不能替代授权检查，也不能在 cache miss 时对同一 key 产生无限 stampede。每次索引/查询变更同时保存计划前后对比、行数估计、实际行数、缓冲命中和写入成本。

`FamilyChange.cursor` 必须在持有 `FamilySyncState` 行锁直到提交的事务中分配；不能用 PostgreSQL sequence、提交后补号或 `updated_at` 代替。所有产生 change feed 的记录写入、snapshot/export/delete 相关变更和重试都复用该顺序。OPS 并发证据必须冻结较低 cursor 的事务并证明较高 cursor 不能先提交，随后检查 feed 连续性和高水位分页无缺口。

### 5.3 Task/Run、Redis、BullMQ 和对象

TaskExecution/Run 的创建、状态迁移和结果落库必须在 PostgreSQL 事务内完成；成功的 API 提交先写入事实表和 `TaskOutbox`，再返回 202/2xx。scheduler/dispatcher 每秒只领取到期 `TaskOutbox` 行，使用 `FOR UPDATE SKIP LOCKED` 和短时 `dispatchLease`（owner、expiresAt、attempt）避免多个 dispatcher 重复认领；提交领取事务后再 `queue.add`，使用稳定的 `taskExecutionId + attempt` job ID。queue.add 成功但 outbox 更新失败时，只允许用同一 job ID 重试/去重，不能创建新的业务 attempt；queue.add 失败则释放/延后 dispatch lease 并退避。dispatcher 不能设置 `TaskExecution` 的业务 lease 或 fencing token。

worker 才能在数据库事务中条件领取 `TaskExecution`（queued 或 lease 已过期），设置 60 秒业务 lease、每 15 秒 heartbeat 并递增 fencing token；旧 token 的更新必须被条件更新拒绝。worker 的执行头 claim/heartbeat/terminal/cancel 锁只锁 `TaskExecution`，`AiRun` 不另复制或竞争一份 lease；领域副作用仍按 02 规定的 User/Family 状态锁顺序执行。reconciliation 每 30 秒扫描 PG 的 queued、running-expired 和非 terminal outbox，并按同一 stable job ID 重新派送；Redis 重启、AOF 丢失或 queue 被清空只能造成唤醒延迟，不能丢失 PG 已接受的任务。取消事务必须条件写入 `cancelRequested` 并使当前 execution lease/fence epoch 失效；取消、工具写入和 terminal transition 必须在提交前重新检查 `TaskExecution` 的 cancel 状态和 fence。取消先提交则后续副作用拒绝，业务写先提交则取消不能回滚它。BullMQ 只承担快速派送和唤醒，不能把 Redis 中偶然存在的 job 当作唯一事实。

Redis 8 固定拆成两个实例。queue 实例默认 `noeviction`、AOF，专门承载 BullMQ 的 job、lock、retry 和事件；cache/rate 实例单独配置可驱逐策略，只存有 TTL 的可重建 cache、限流桶和短期连接辅助状态。两个实例使用不同连接串、不同容器/卷、不同告警和不同备份策略；cache 的驱逐绝不能影响 queue。queue key、job data、lock、retry 和 stream 事件使用稳定前缀和保留策略。queue 实例 `evicted_keys` 非零是 P0 失败；即使业务请求仍返回 200，也不能签字通过。

BullMQ 5 使用 at-least-once 语义、租约/锁、指数退避和有界 attempts。工具写入和对象处理必须有稳定 job ID/effect idempotency key，数据库副作用按 effect key 去重。provider 调用在网络超时、进程退出或响应丢失时可能已经成功；系统不能宣称跨 provider 的 exactly-once，只能使用 provider idempotency key/query、幂等落库和 `unknown/pending_reconciliation` 状态，无法查询时转人工处置。队列容量按 waiting、active、delayed、failed、completed 的保留策略测算，不把无限保留的 completed job 当作长期数据仓库。

S3 bucket 开启 Block Public Access、服务端加密、版本/校验和和最小 IAM。数据库只保存 owner/family/baby 关联、对象 key、大小、hash 和状态；对象 GET/stream 由受保护 API 做租户授权并代理响应，签名 URL 仅用于上传且短时、单对象、绑定 owner/size/checksum。压力测试至少包含合成小对象上传、断线重试、重复 upload ID、越权 GET 和过期上传 URL；S3 的 403/私有性与 API 2xx 不能只靠配置截图证明。

### 5.4 CPU、内存和流

API 要观测 event-loop lag、GC pause、RSS、heap、native buffer、socket、活跃请求和 SSE 数量。任何 JSON 聚合、报告生成和图像处理不得无界地在 API event loop 上运行。worker 的 provider/IO 并发与 CPU 密集处理拆开；CPU 密集步骤使用 sandboxed process 或独立 queue。

Caddy 只负责 TLS、连接级反代、连接/请求体上限、SSE flush/idle 和优雅 reload；Caddy 原版不承担应用 rate limiting。请求级限流和配额必须在 Fastify rate-limit 层实现，并使用独立 cache/rate Redis；Redis 降级时按 feature 返回明确 503 或受控 fallback，不能让 Caddy 假装已限流。不能用无限 timeout 掩盖后端卡死。应用日志使用 request ID、tenant-safe hash、role、queue job ID 和耗时，不写 prompt、病历正文、token、签名 URL 或完整宝宝资料。

## 6. SLO、RPO、RTO 和恢复

### 6.1 SLO 与“业务已提交”定义

业务写入只有在 PostgreSQL 事务提交、必要的幂等记录存在、需要派发的 outbox 事件也已持久化后才返回 2xx。客户端收到网络错误或超时，不能推断写入失败；用同一幂等键查询最终结果。API、worker 和 provider 的进程崩溃只允许造成响应不确定或任务重试，不能让已返回 2xx 的业务记录消失。只有服务端在事务开始前明确记录为 `rejected` 的业务拒绝才可证明未提交；4xx/5xx、连接断开和 timeout 可能发生在 commit 前后，结果未知时必须用同一 command/idempotency key 查回并按最终状态重试，不能按状态码一概断言未提交。

长期在线 SLO 目标：REST 月可用性 99.9%；核心读写和 SSE 门槛沿用第 4.4 节；已提交业务写在单进程/容器/Redis 重启中零丢失；任务在正常 provider 可用时 99% 能在 30 秒内进入 running；恢复演练达到下表的 RTO/RPO 后才可宣称达到目标。

| 故障 | 目标 RPO | 目标 RTO | 说明 |
|---|---:|---:|---|
| API 容器崩溃/滚动发布 | 0（已提交写） | ≤ 2 分钟 | Caddy 摘除不健康实例；幂等重试，SSE 从游标补发 |
| worker 崩溃 | 0（已落库结果；PG 已接受任务不丢） | ≤ 5 分钟；健康 worker 的替代任务目标 ≤ 121 秒进入 running | lease 过期后重新领取；重复任务必须幂等；provider unknown 进入可查询/人工处置状态 |
| Redis 重启/queue 丢失 | PG 已接受的 TaskExecution/TaskOutbox RPO = 0；AOF 最后 fsync 只代表唤醒 job，目标 ≤ 1 秒；cache 不设 RPO | ≤ 5 分钟；reconciliation 恢复目标 ≤ 121 秒 | queue `evicted_keys=0`；从 PG queued/running-expired/outbox 重建并核对 waiting/active/delayed/failed |
| PostgreSQL 单主机/磁盘灾难 | WAL 归档目标 ≤ 5 分钟；不能声称跨灾难 RPO 0 | ≤ 60 分钟 | 需要可用 base backup + WAL 和已演练的 restore；单机预算不是 HA 证明 |
| S3 对象故障 | 以版本化/复制策略确定；默认不能丢已确认对象 | ≤ 60 分钟 | 数据库对象状态与 S3 key 对账；私有访问保持不变 |

在 15 秒 heartbeat、60 秒 TaskExecution lease、30 秒 reconciliation、1 秒 outbox dispatch 和健康 worker 启动预算下，worker 恰在 heartbeat 后崩溃时，过期检测最迟约 `60 + 30 = 90` 秒，重新派送最迟再加约 1 秒；把 worker claim/start 预算计入后，替代任务进入 running 的目标为 ≤121 秒。5 分钟是包含进程恢复、队列回放和 backlog 排空的服务 RTO，不能把“5 分钟内最终完成”误写成 provider exactly-once。provider 请求在网络/进程故障后可能已经成功，系统必须依靠 provider idempotency/query、effect key 和 `unknown/pending_reconciliation`，不能承诺不可逆外部副作用 exactly-once。

RPO 的“0”只用于已提交业务写和 PG 已接受的 TaskExecution 在应用进程、容器或Redis重启且PG持久数据完好的边界内的目标。若没有同步副本或已验证的持续 WAL 归档，不能把它扩展为机房灾难 RPO 0。RTO 是从告警确认到 ready 恢复的目标，不是从开发者开始排查的乐观时间。

### 6.2 Backup/restore 演练

PostgreSQL 使用定期 `pg_dump` custom archive、基于 WAL 的 base backup/连续归档和私有 S3 保留。生产备份不写应用容器本地可丢卷；备份 artifact 包含 manifest、数据库/对象计数、schema migration 版本、checksum、生成时间和保留策略，不包含连接密码。

至少每月在 `test_restore_<run_id>` 上做一次完整恢复演练，每次大版本/数据库/迁移/对象策略变更前再做一次：

1. 从合成或脱敏快照恢复 PostgreSQL 到干净 PG18 实例，使用 `pg_restore --exit-on-error`，执行 `ANALYZE` 并记录 row count/checksum。数据库导出使用 repeatable-read snapshot 写入临时文件；事务最长 30 秒，临时文件关闭后才上传 S3，不能在 S3 网络传输期间持有数据库事务。
2. 恢复 WAL/base backup 时验证 manifest、校验和、时间点和恢复日志；不得只看到命令退出 0 就算成功。
3. 恢复 S3 私有对象到隔离 bucket，核对数据库中的 object key、byte size、hash 和访问授权；用无权限请求确认返回 403。
4. 启动同版本 API/worker，跑读、分页、写幂等、SSE 补游标、任务重试和跨租户拒绝；再故意杀掉 API/worker，验证 RTO 内恢复。
5. 将恢复前后计数、抽样 hash、queue 状态、耗时、缺失/重复和人工操作记录保存到 artifact；任何缺失都阻断发布。

建议命令形态为 `pg_dump --format=custom`、`pg_restore --list`、`pg_restore --exit-on-error`、`pg_basebackup`/`pg_verifybackup` 和应用级 `npm run verify:restore`。具体 host、bucket、secret 由部署环境注入，文档和日志不得硬编码。

## 7. 部署、迁移与无丢写回滚

### 7.1 发布顺序

发布采用 immutable image、健康检查、先扩展兼容代码再迁移数据的 expand/backfill/contract 顺序：

1. 构建并签名 API/worker 镜像，固定 digest；运行 Node 24、依赖锁文件、schema、Caddyfile 和 compose config 检查。
2. 在独立 PostgreSQL test database、staging 和恢复副本依次通过受控 migration runner 执行 Prisma migrations。生产不运行 `db push`，不从应用启动时偷偷执行 migration；CI/test runner 使用 06 的 `backend:db:test:migrate` wrapper。
3. 先部署能读取旧字段并写新字段的兼容 API/worker；完成 backfill、计数和 shadow read；确认旧 SwiftUI/Web 客户端仍能写入。
4. Caddy 先校验配置，再 reload；新实例只有 `/health/ready` 通过且迁移版本正确时加入 upstream。SSE 老连接按优雅退出和游标重连处理。
5. 观察错误率、query plan、pool、queue lag、对象上传和客户端重连；通过后才进入 contract/drop 迁移。删除字段和旧索引必须另一个发布窗口执行。

### 7.2 SQLite 到 PostgreSQL 的首次迁移

现有数据迁移不能把 SQLite 文件复制成 PostgreSQL data directory，也不能只导入表而忽略对象和审计。由于当前输入没有可直接信任的 change-data-capture，第一次迁移默认使用可审计的**写围栏**；未来再考虑双写/变更日志降低停写时间。

1. 在生产前做只读快照、schema/row count/每租户 hash、S3 对象 manifest、当前 job 状态和应用版本记录；先在恢复副本演练。
2. 部署能识别 `MIGRATION_DRAINING` 的兼容版本。Caddy/应用对新的写请求返回明确的 503 + `Retry-After`，客户端不把被拒绝请求当成已提交；等待已进入的写事务、上传 finalize 和 queue enqueue 完成。
3. 写围栏后再次确认 in-flight write = 0，导出 SQLite 数据、对象和任务状态到隔离导入区；导入 PG18，建立索引，运行 `ANALYZE`，验证总数、分租户数、hash、外键、幂等唯一键和 S3 key。
4. 启动 PostgreSQL 版 API/worker 做 shadow read 和只读 smoke；验证 SwiftUI 登录、列表、游标、SSE、私有对象、任务状态和跨租户拒绝。
5. 切换 Caddy upstream 到 PostgreSQL 版，保持旧 SQLite 只读保留窗口；先观察一段固定时间，再解除写围栏。围栏期间返回 503 的请求必须由客户端按协议重试，不允许被当成丢失写。

“不丢写”的验收对象是所有已经返回 2xx 或在围栏前已提交的事务；它们在 PG 中逐条存在且 hash 对得上。围栏内被明确拒绝的请求没有业务提交，必须可重试。迁移报告必须分别给出：已提交写、被拒绝写、重试成功写、重复幂等写、失败写和未决请求。

### 7.3 回滚规则

应用镜像可以独立回滚；数据库 migration 采用 forward fix，禁止把生产数据库降级成旧 schema 以换取“看起来的回滚”。如果 cutover 后尚未接受任何新写，且 PG 通过完整核验，才可以将 upstream 指回旧版本。只要 PG 已接受新写，就不能直接指回不含这些写的 SQLite/旧数据库；必须先继续在 PG 修复，或执行带 checkpoint、幂等键和校验的增量导出/回放，再决定路由。

以下任一项立即停止发布并保留现场：已提交写计数不一致、重复/丢失幂等键、跨租户读取、S3 对象公开、Redis `evicted_keys > 0`、队列 job 不能恢复、migration 半执行且无恢复证据、Caddy 将流量导向未 ready 容器。停止发布不是数据回滚；先恢复可读性、冻结写入、保存备份和日志，再执行 forward fix 或经过演练的恢复。

## 8. CI checks 与执行门禁（拟新增）

下列命令统一采用 06 的 `backend:*` 接口；实现时应保持可在本地和 CI 使用，并把运行 ID、数据库名和 artifact 目录显式打印。CI 不直接调用裸 ORM CLI、默认主机数据库客户端或未登记的旧脚本。

| 检查 | 建议命令 | 门禁 |
|---|---|---|
| Node/依赖 | `npm run backend:doctor`; `npm run backend:deps:test` | Node 24 LTS patch 与 lockfile 一致；依赖/环境 guard 通过 |
| TypeScript/lint | `npm run backend:typecheck`; `npm run backend:lint` | 0 类型/ lint 错误 |
| contracts/schema | `npm run backend:contracts:generate`; `npm run backend:contracts:check`; `npm run backend:db:validate` | contract 与 schema 无漂移；禁止 `db push` 进入 release workflow |
| PG migration fresh | `npm run backend:db:test:migrate -- --run-id <id>` | 在隔离 PG18 database 完整 migrate，不能读 SQLite |
| 隔离 API | `npm run backend:test:integration -- --suite api --run-id <id>` | 每次使用隔离 `test_<run_id>` database；账号/家庭/宝宝带前缀；runner 负责唯一创建清理并保存审计 |
| 隔离 E2E | `npm run backend:test:integration -- --suite e2e --run-id <id>` | 每次使用独立 `e2e_<run_id>` database；Web/SwiftUI 适配环境不共享生产或 load database |
| AI mock | `npm run backend:test:integration -- --suite ai-mock --run-id <id>` | 默认 mock provider，测试没有真实外部计费；真实 provider 只能显式、限额、合成数据运行 |
| query plan | `npm run backend:test:integration -- --suite query-plans --run-id <id>` | 固定数据 manifest 上保存 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 和原始 timing；热查询无意外全表扫/无限排序 |
| Redis/BullMQ | `npm run backend:test:chaos -- --suite queue-recovery --run-id <id>` | queue dedicated `noeviction` + AOF、cache/rate 独立可驱逐；重启、stalled job、重试、幂等和 PG TaskExecution reconciliation 通过 |
| S3 private | `npm run backend:test:integration -- --suite objects-private --run-id <id>` | 未授权 API GET = 403；仅上传签名 URL 过期失败；checksum、owner 关联和重试通过 |
| 容器/入口 | `npm run backend:doctor`; `npm run backend:evidence:check -- --task OPS03` | 不暴露 PG/Redis/API 管理端口；Caddy、live/core-ready/dependency-details 和 SSE 配置可解析 |
| 构建 | `npm run backend:build` | API/worker/scheduler 镜像可启动、优雅退出、健康检查和 digest 可记录 |
| load smoke | `npm run backend:load:test -- --profile smoke --run-id <id>` | 低负载脚本、标签、threshold、SSE harness 和 summary artifact 有效；loadgen 无资源瓶颈 |
| load full | `npm run backend:load:test -- --profile target --run-id <id>` | 10m/30m/10m/2h 完整运行达到硬门槛；结果不能只看退出码 |
| backup/restore | `npm run backend:test:chaos -- --suite backup-restore --run-id <id>` | `test_restore_<run_id>` 恢复后计数、hash、对象、队列、读写、SSE 和 RTO 通过 |
| security/evidence | `npm run backend:evidence:check -- --task OPS01` | 高危阻断；日志/环境/对象没有 secret 或正文泄漏 |

本地隔离 PG 的最小流程只允许通过 `backend:test:guard`、`backend:db:test:migrate`、`backend:test:integration`/`backend:test:chaos` 和 `backend:evidence:check` 完成；隔离 runner 读取 `TEST_PG_ADMIN_URL` 等受保护 secret，自行创建一次性 `test_<run_id>`/`e2e_<run_id>` database 并在所有退出路径清理。配置层和 Prisma 初始化层都要在测试模式下硬拒绝 `file:`，并拒绝未带 `test_`/`e2e_` 前缀的 database 名。原有 SQLite 临时服务命令不能作为新门禁通过。

## 9. 故障与并发验收案例

| 案例 | 注入方式 | 期望结果 |
|---|---|---|
| 同一幂等键 50 并发写 | k6/脚本同时提交相同 key，部分连接主动断开 | 恰好一条业务记录；所有重试得到同一结果或明确冲突；无重复副作用 |
| 两个照护者并发追加 | 两个 test 用户对同一宝宝写不同事件 | 两条合法事件都存在；授权基于 session principal，不信任客户端 baby/user ID |
| Family cursor 提交顺序 | 事务 A 锁住 `FamilySyncState` 后暂停；事务 B 同家庭写入并尝试提交；再释放 A | B 不能越过 A 提交更大的 cursor；提交后 cursor 连续、change feed 无缺口；不同家庭仍可并行 |
| 版本冲突 | 并发更新同一记录 | 一个成功，一个可见 409/冲突状态；不能静默覆盖 |
| cancel 与 worker 副作用竞态 | 在 worker 提交前并发取消，分别注入锁等待和 provider 返回 | 同一 `TaskExecution` 锁序决定先后；取消先提交则旧 fence 的写被拒，业务写先提交则取消不回滚；状态和审计可查 |
| API 在 commit 前/后崩溃 | 进程 kill、连接断开、响应丢弃 | commit 前可安全重试；commit 后幂等查询找回；已返回 2xx 的写不消失 |
| worker 在 provider 成功后崩溃 | kill worker、等待 TaskExecution lease 过期 | job 按同一 stable ID 重试；DB effect 唯一；provider unknown 不宣称 exactly-once，进入 query/reconciliation 或人工状态 |
| Redis 重启/AOF 恢复 | 重启 Redis、恢复隔离备份并清空部分 queue keys | PG queued/running-expired/TaskOutbox 可重建；≤121 秒目标进入 running；`evicted_keys=0`；cache 可重建 |
| PostgreSQL pool 耗尽 | 暂时减小可用连接或注入慢事务 | 新请求有界失败并可恢复；无无限等待；10 个运维连接仍可诊断 |
| Caddy/SSE 断开 | 中断连接、reload、网络抖动 | 客户端在游标位置重连，补发不重复不丢失；旧连接被回收 |
| S3 上传中断/越权 | 中途断网、重复 upload ID、换 tenant key | 校验失败不进入已完成状态；越权 403；重试不产生重复对象 |
| migration 中途失败 | 在 backfill/index/切换阶段 kill | 旧路径或隔离状态可诊断；不删除旧数据；不能直接把流量指向半迁移 schema |
| 磁盘/内存压力 | 限制容器资源、填充临时盘 | readiness/告警触发；queue 不被淘汰；恢复后 backlog 可下降；无 OOM 静默丢任务 |

并发测试必须同时保存业务对账：k6 成功数、API 2xx 写数、PostgreSQL 插入/更新数、幂等冲突数、BullMQ 成功/失败数和 S3 finalized 对象数。只看 HTTP 200 或仅看平均延迟不能验收一致性。

## 10. OPS 任务执行与验收

每个 OPS 任务由执行 Agent 提供输入、命令、原始 artifact 和结论；review Agent 从干净工作树/独立测试数据库复跑关键命令，不能以执行 Agent 的口头报告代替证据。任务状态只能是 06 规定的 `NOT_STARTED`、`IMPLEMENTED_NOT_REVIEWED`、`ACCEPTED`；只有 review Agent 按证据复核后才能写 `ACCEPTED`，“代码已写”不等于“运行时已通过”。

| 任务 | 输入 | 步骤 | 验收 |
|---|---|---|---|
| OPS01 版本与边界 | package lock、Docker/Compose、Caddyfile、环境变量名清单 | 锁定 Node24/Fastify5/TS/Prisma7/PG18/Redis8/BullMQ5/k6/Caddy patch；检查 secret 不入镜像和日志 | 版本 manifest、compose hash、无生产 secret；review Agent 可从干净环境复现启动 |
| OPS02 PostgreSQL 迁移 | 目标 schema、Prisma migrations、脱敏/合成 fixture | 改为 `adapter-pg`；fresh PG18 migrate、`ANALYZE`、schema diff、权限角色检查 | `backend:db:test:migrate` 成功；无 SQLite 测试路径；迁移可重跑且无 destructive 未审动作 |
| OPS03 API/worker/scheduler 分离 | API ×2 entry、worker entry、scheduler/dispatcher entry、Dockerfiles、health routes | 构建两个 API 容器，另建独立 worker 和 scheduler/dispatcher 容器，配置优雅退出、pool、core-ready/dependency-details、Caddy upstream 和 SSE | kill/replace 任一 role 后其他 role 不受影响；API 每副本 pool=25、worker=14、scheduler/dispatcher=6；日志 role 和连接预算正确 |
| OPS04 Redis/BullMQ | queue 名称、job schema、TaskExecution 与 TaskOutbox 租约策略 | 启动两个 Redis8：queue dedicated `noeviction` + AOF，cache/rate 独立可驱逐；验证 worker DB lease=60s/fence、heartbeat=15s、outbox dispatch lease、AOF、重启、stalled 和幂等 | queue `evicted_keys=0`；30s reconciliation、≤121s 恢复目标、队列恢复、重试、重复任务和 worker drain 均通过；dispatcher 不得领取业务 lease |
| OPS05 私有对象 | S3 bucket/prefix/IAM、合成对象 | 配置私有 bucket、加密、版本/校验和、上传签名 URL、生命周期；受保护 API 跑越权 GET/过期/断点 | 未授权 API GET 403；hash/owner 对账通过；没有公网或签名 read URL |
| OPS06 压测数据 | `test_load_<id>` PG、生成器、S3/Redis 隔离资源 | 生成 10k 家庭、2k DAU、10M 记录、50k 重家庭；执行 preflight | manifest、row counts、tenant distribution、seed hash 可复核；生产数据库连接为 0 |
| OPS07 REST 基线 | k6 脚本、mock AI、测试入口 | 10m warm + 30m steady，100 RPS 固定 80/20 endpoint mix；mock 8s/3 task/s，in-flight 至少 24；按 endpoint/tenant 分桶 | 第 4.4 REST P95/P99/错误率和资源门槛通过；queue concurrency 及预算有实测记录 |
| OPS08 SSE/在线 | 200 Node fetch/ReadableStream SSE、k6 800 session、SwiftUI reconnect harness | barrier 同步两套 harness 建立 1k 连接；断开、reload、重连、补游标；不长持 DB client | 建立/事件延迟、无丢失/重复，连接/FD/内存无泄漏；SSE 原始 event timing 可复核 |
| OPS09 冲击与浸泡 | 已通过 steady 的镜像和同一数据 manifest | 10m 200 RPS；回到 100 RPS 做 2h soak；记录首 10m recovery | 峰值和恢复门槛通过；无长尾、内存、WAL、pool、queue 单调恶化 |
| OPS10 查询计划 | 10M 数据、热门 query registry | 逐 query `EXPLAIN ANALYZE BUFFERS`；检查索引、keyset、聚合和 vacuum | 无未解释全表扫/大排序/锁等待；计划 artifact 与 migration 一起评审 |
| OPS11 真实 AI 小配额 | 合成 prompt、allowlist provider、预算和限额 | 以 `ai_mode=real` 单独跑提交、重试、结果落库和断连恢复 | provider 延迟单列；预算、隐私、错误终态和重复副作用均可对账 |
| OPS12 故障/并发 | 故障注入脚本、对账查询 | 执行第 9 节所有 P0/P1 案例，保留前后状态、TaskExecution fence 和 idempotency lookup | 已提交写零丢失；任务不重复产生 DB 副作用；provider unknown 有可查询/人工路径；故障有告警和恢复记录 |
| OPS13 备份恢复 | base backup/WAL、pg_dump、S3 manifest | 在 `test_restore_<id>` 恢复数据库/对象/queue，启动同版本 API/worker/scheduler | 计数/hash/权限/TaskExecution/TaskOutbox 一致；读写/SSE/幂等通过；RTO/RPO 达标 |
| OPS14 首次数据迁移 | SQLite 只读快照、导出 manifest、兼容版本 | 写围栏、导出、PG 导入、索引/分析、对账、shadow read、Caddy cutover | 所有已提交写存在；被拒写可重试；无重复/越权/半迁移流量 |
| OPS15 回滚/forward fix | 旧镜像、新镜像、迁移 checkpoint | 在 test/staging 注入 migration/API 故障；模拟 cutover 后新写，再演练修复 | 不用旧库覆盖新写；rollback 方案不会丢写；forward fix 和审计记录完整 |
| OPS16 SwiftUI 端到端 | SwiftUI 测试包、游标/任务 fixture | 断网录入、强退、恢复、SSE 重连、AI 任务返回、附件上传签名 URL 和受保护 GET | 客户端不把未提交当成功；返回后能拉取权威状态；多家庭不串号 |
| OPS17 CI 发布门禁 | workflow、compose.test、CI PG/Redis/S3 mock | 只跑 06 的 `backend:*` wrappers：doctor/deps/typecheck/lint/contracts/db/test/chaos/build/load/evidence；SSE harness 与 k6 smoke/container/restore 由 wrapper 编排 | PR 门禁可复现；真实 AI 不默认调用；所有 test/e2e database 由隔离 runner 创建清理并通过多因素 allowlist 核验 |
| OPS18 独立 review | OPS01–17 artifact bundle | review Agent 复跑抽样和所有 P0；核对 commit/config/data/时间；列出残余风险 | 所有硬门槛有原始证据和结论；未通过项保持 `IMPLEMENTED_NOT_REVIEWED`；发布负责人签字 |

## 11. Review evidence matrix

最终 evidence bundle 至少包含：Git SHA 和 lockfile hash、Node/依赖/镜像 digest、Compose/Caddy 渲染配置、schema/migration hash、测试数据库名和清理证明、seed manifest、k6 raw/summary、Caddy/API/worker/PG/Redis/queue/S3 指标、query plan JSON、故障注入日志、backup/restore manifest、SSE/SwiftUI 录制或结构化客户端日志、成本/真实 AI 配额和 reviewer 结论。截图只能辅助说明，不能代替 raw metric、row count、query plan 或恢复日志。

| 证据 ID | 要证明的结论 | 必须提供 | 通过条件 | 独立复核 |
|---|---|---|---|---|
| E-01 | 目标版本固定 | `versions.json`、lockfile、镜像 digest | 所有进程和 loadgen 版本一致 | review Agent 在干净 checkout 执行版本命令 |
| E-02 | 测试数据隔离 | PG audit、数据库名、账号/家庭前缀、drop log | 只有 `test_`/`e2e_`；生产/SQLite 连接为 0 | review Agent 查询连接日志和 cleanup |
| E-03 | schema/migration 可部署 | fresh PG18 migrate、diff、权限、schema hash | migrate 0 error；无 drift；无未审 destructive SQL | review Agent 重建空库并重跑 |
| E-04 | API/worker/scheduler/Caddy 拓扑 | compose render、role/pool manifest、core/dependency health、graceful shutdown log | API 两副本各 25 pool；worker 14；scheduler/dispatcher 6；外部只见 Caddy；PG/schema/auth core-ready 正确，依赖降级可见且不令普通记录 API 整体下线 | review Agent kill/restart 抽样 |
| E-05 | 数据规模达到目标 | seed manifest、row count、租户分布 | 10k/2k/10M/50k 约束精确满足 | review Agent 抽查 SQL 和 hash |
| E-06 | 100 RPS REST 达标 | k6 raw + endpoint mix manifest + tagged summary + API/PG metrics | 80/20 固定组成、P95/P99、错误率、资源全过；非 2xx/timeout 的 commit unknown 有幂等对账 | review Agent 复跑至少一次 |
| E-07 | 2x 冲击可恢复 | spike timeline、error/queue/pool graph | 200 RPS 阶段和 ≤10m recovery 门槛通过 | review Agent 对账 2xx/写入/重试 |
| E-08 | 1k 在线/200 SSE 达标 | Node SSE harness raw event timing、k6 800 session、connection/fan-out/reconnect metrics | 建立、事件、回收、补游标无丢失/泄漏；两套 harness 阶段窗口一致 | review Agent 主动断流复验 |
| E-09 | query/index 经过计划验证 | JSON `EXPLAIN` 前后、migration、histogram/原始 query timing | 热查询无未解释 seq scan/大排序；分页可扩展；P95/P99 不从 `pg_stat_statements` 累计值冒充 | review Agent 用同 manifest 执行 |
| E-10 | pool/resource 有界 | PG `pg_stat_activity`、pool、CPU/RAM/GC | ≤70 app connection；无耗尽/OOM/swap | review Agent 核对预算算式 |
| E-11 | queue 不被驱逐 | Redis INFO、AOF、TaskExecution/TaskOutbox、BullMQ 状态 | `evicted_keys=0`；worker lease/fence 与 outbox dispatch lease 分离；PG 事实在重启/queue 丢失后 ≤121s 目标可恢复 | review Agent 重启隔离 Redis |
| E-12 | provider 延迟隔离 | mock/real 分开报告、provider tags | 核心 REST 不混 provider；真实 AI 有预算 | review Agent 检查 k6 tag 和分母 |
| E-13 | S3 保持私有 | policy、受保护 API 403、上传 signed URL、checksum | 越权 GET/过期上传 URL 均失败；已确认对象可经授权 API 恢复 | review Agent 用无权身份请求 |
| E-14 | backup/restore 可用 | dump/base/WAL/manifest/restore log | 计数/hash/对象/queue 对账；RTO/RPO 达标 | review Agent 恢复到全新 test DB |
| E-15 | 发布迁移不丢已提交写 | fence ledger、cutover log、前后 hash、command/idempotency lookup | 2xx/已提交写 100% 可见；非 2xx/timeout 的未知结果可查回；写围栏明确拒绝的请求可重试 | review Agent 注入响应丢失/kill |
| E-16 | 回滚不覆盖新写 | checkpoint、forward-fix/rollback runbook | 不把旧库直接指回覆盖 PG 新写 | review Agent 模拟 cutover 后写入 |
| E-17 | CI 门禁有效 | CI URL/artifacts、命令输出 | PG-only test、容器、Caddy、restore、k6 smoke 均可复跑 | review Agent 重新触发工作流 |
| E-18 | 客户端可恢复 | SwiftUI log、SSE cursor、任务状态 | 断网/强退/重连后权威状态正确；无串租户 | review Agent 用两个 test 家庭复测 |

任何 P0 失败（丢已提交写、越权、生产污染、公共对象、queue eviction、无法恢复的任务或数据库、无证据宣称通过）都自动阻断发布。P1 失败必须记录 owner、修复版本、复测命令和期限，不能用“平均值不错”关闭。

## 12. 长期维护节奏

每个合并请求执行 schema/type/lint/隔离 PG 单元与集成门禁；每日或每周执行 k6 smoke、query plan 抽样、Redis/queue health 和容器镜像扫描；每次大版本、schema、索引、worker 并发、Caddy、Redis、PostgreSQL、provider 或 SwiftUI SSE 代码变更执行完整容量运行和 backup/restore 演练。至少季度重新跑 10M 记录、50k 重家庭、1k 在线、200 SSE 和 2h soak，并比较前后 P95/P99、错误、资源、queue lag、WAL、成本和恢复时间。

当数据形状、客户端行为或 provider 变化时，旧结果自动降级为历史 baseline。报告要同时保留“当前实现事实”“本次目标配置”“本次运行结果”“尚未证明的风险”，不把目标架构、CI 绿色、staging 通过或一次本地压测写成生产容量保证。

## 13. 官方一手资料

只使用以下官方文档作为技术行为依据；版本和实现发生变化时，在下一次 OPS01 review 更新链接和锁定版本：

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [Fastify v5 documentation](https://fastify.dev/docs/v5.7.x/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Prisma 7 PostgreSQL connector and `@prisma/adapter-pg`](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
- [PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/)
- [PostgreSQL 18 backup and restore](https://www.postgresql.org/docs/18/backup.html)
- [Redis 8.0 documentation](https://redis.io/docs/latest/develop/whats-new/8-0/)
- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [BullMQ documentation](https://docs.bullmq.io/)
- [k6 metrics and thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/)
- [Docker Compose in production](https://docs.docker.com/compose/how-tos/production/)
- [Caddy `reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Amazon S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
- [Apple SwiftUI documentation](https://developer.apple.com/documentation/swiftui)
