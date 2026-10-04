# BE Weather parity

任务：为 Go 服务端增加 `GET /api/v1/weather`，给旧 Web/iOS 共用天气响应，并验证隔离 HTTP 行为。

状态：`IMPLEMENTED_NOT_REVIEWED`。

基线 HEAD：`88ecf7d4bbad6bc41a08eca6882b3882be22fe07`。本任务仍是未提交工作树差异；服务端契约引用为 `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`。

行为变化：带有效 Bearer 的天气请求可按显式城市、成对经纬度或默认苏州读取天气。城市路径只访问地理编码服务；默认苏州直接使用固定坐标；经纬度路径不地理编码。响应保留当前温度、天气现象、日最高 UV、降雨概率、湿度、逐小时预报和户外提示，并附来源、单位、IANA 时区、观测/获取时间与缓存状态。逐小时结果从 provider 当前本地小时起取最多八项，按时间戳关联空气质量 UV；请求两日预报以覆盖跨午夜窗口。

缺失或越界的观测值返回 `null`。空气质量明确标为欧洲 AQI 与 CAMS/Open-Meteo 来源，不套用中国 AQI 分段；空气质量服务不可用时天气仍可返回。户外提示只说明天气、降雨、UV 或欧洲 AQI 条件，不提供婴儿临床建议。provider 主机固定在 Open-Meteo 服务表，响应限制为 512 KiB，超时 3 秒且不跟随重定向；测试 override 只接受显式 loopback HTTP origin，test 环境缺 fixture 时 fail closed。Redis 新鲜数据缓存十分钟，provider 失败时最多回退到 24 小时内缓存，并标记 stale。

实现改动：

- `packages/contracts/src/weather.ts`、`packages/contracts/src/routes.ts` 和 `contracts/openapi.json` 新增 Weather DTO、query schema 与 `getWeather` operation。
- `internal/backend/weather.go` 新增 Go handler、固定 provider adapter、映射、来源/单位、时区逐小时关联与 Redis fresh/stale 行为。
- `internal/backend/config.go`、`internal/backend/server.go`、`internal/backend/register.go` 接入测试 fixture 配置、provider lifecycle 与路由。
- `internal/backend/contract.go` 在契约 query 参数规范化前拒绝 Weather schema 外字段，避免未知参数被静默删除。
- `internal/backend/weather_test.go` 和 `packages/contracts/tests/weather-contract.test.ts` 覆盖解析、数据缺失、AQI 分类、时区/逐小时边界与契约。
- `scripts/go-weather-parity-integration.py` 使用真实 Go HTTP API、独立 PostgreSQL 18.6/Redis 8 进程和 loopback 虚拟 Open-Meteo 协议 fixture 做端到端验收；清理时记录 postmaster PID、数据目录、PostgreSQL 启动时间及进程启动身份，检查 `pg_ctl stop` 退出码并验证原 PID 确实终止。stop 失败或启动身份不匹配时报告清理失败并保留所有权目录，不触碰身份不匹配的进程。
- `scripts/test_weather_cleanup.py` 对 stop 失败和 postmaster 启动身份不匹配的保留目录/fail-closed 路径做回归验证。

隔离环境：修复后的最终 HTTP run 为 `5b87d2a685dafd00`，测试账号 `test_weather_5b87d2a685dafd00`，PG database/role 都按本次随机 `test_weather_` 名称创建；PG、Redis、API 与 provider fixture 仅监听 loopback。HTTP 证据记录 postmaster PID `40726`、启动身份、`pg_ctl stop` exit code `0` 和 `ownedPIDTerminationProven=true`；验证后该 PID 已不存在，owned 临时目录已删除。没有读取生产凭据、连接外部天气服务、旧 Web SQLite 或 3088/3089。天气 GET 不涉及家庭/宝宝写入或对象存储，因此没有创建家庭/宝宝，也未配置 S3。

历史 HTTP run `1b2dddb59e74ee42` 及更早 run 全部保留未改。独立审查发现旧 runner 在 `pg_ctl stop` 失败时会吞错、删除 PG 目录，并可能据目录已删除错误报告 `postgresStopped=true`；因此旧 run 的清理字段仅作为历史记录，不能证明对应进程已停止。修复后的 `5b87d2a685dafd00` 是当前清理证明。

自动验证：

| 命令 | 结果 |
|---|---|
| `go test ./internal/backend -run 'Weather' -count=1` | 通过 |
| `env -u TEST_PASSPORT_DATABASE_URL go test ./...` | 通过；Passport 专项 PostgreSQL 集成需要独立显式数据库，本任务没有提供该服务 |
| `go vet ./...` | 通过 |
| `go build -o /private/tmp/growdesk-weather-parity-20261003-api ./cmd/growdesk-api` | 已由原 run 构建；二进制 SHA-256 见 `SHA256SUMS.txt`，修复未改 Go 业务源码 |
| `python3 -m py_compile scripts/go-weather-parity-integration.py scripts/test_weather_cleanup.py` | 通过，exit code 0 |
| `python3 scripts/test_weather_cleanup.py` | 通过，2 项、0 失败；修复前同一命令 exit code 1，分别复现 stop 失败被误报为成功，以及身份不匹配仍执行 stop；前后结果见 `cleanup-regression.json` |
| `python3 scripts/go-weather-parity-integration.py --binary /private/tmp/growdesk-weather-parity-20261003-api --evidence-dir evidence/tasks/BE_WEATHER_PARITY_20261003` | 13 项通过，exit code 0；新证据 `http-5b87d2a685dafd00.json`，真实 owned PostgreSQL stop exit code 0 且原 PID 终止已验证 |
| `npm run backend:build` | 通过 |
| `npm run backend:typecheck` | 通过 |
| `npm run backend:lint` | 通过，架构检查覆盖 143 个 TypeScript 文件 |
| `npm run backend:test:unit` | 通过，161 项、0 失败、0 跳过 |
| `npm run backend:contracts:check` | 通过，127 paths、176 operations、无 OpenAPI drift |
| `git diff --check` | 通过 |

清理证明修复的本轮复验（退出码）：

| 命令/检查 | 退出码与结果 |
|---|---|
| 修复前 `python3 scripts/test_weather_cleanup.py` | `1`；两项断言失败，复现 stop 假阳性和身份不匹配仍 stop，见 `cleanup-regression.json` |
| 修复后 `python3 scripts/test_weather_cleanup.py` | `0`；2 项通过 |
| `python3 -m py_compile scripts/go-weather-parity-integration.py scripts/test_weather_cleanup.py` | `0` |
| `go test ./internal/backend -run '^TestWeather' -count=1` | `0` |
| `git diff --check` 与本任务文件尾随空白检查 | `0` |
| 修复后的隔离 HTTP run（上表命令） | `0`；13 项通过；新 PG PID 终止检查和目录删除检查均为真 |

HTTP 验收覆盖：未认证请求在触及 provider 前返回 401；默认苏州、手动城市地理编码、坐标路径和经度时区；完整/重复/混合/超界/未知 query 校验；来源、单位、时区与 `fetchedAt`；缺失和部分天气/AQI数据保持 null；欧洲 AQI 分类；provider 503 与超时；新鲜缓存、stale 回退、超过 24 小时拒绝，以及 Redis 中断时明确返回 `cacheState=unavailable`。

早期 red 证据保留作 runner 修复轨迹：`http-2cee12e28b771431.json` 发现宿主 `LC_ALL` 不适合本机 PostgreSQL，之后 runner 固定 C locale；`http-1299ab99be49b18d.json` 是东京标签预期重复行政区名，修正测试预期；`http-780aaaf19a2aa706.json` 与 `http-d4e4bd16d2858029.json` 暴露 query 规范化静默丢弃未知字段，已在 Weather 校验前拒绝。其它较早 red 记录仍原样保留。当前最终完整 run 是 `http-5b87d2a685dafd00.json`，13 项通过并逐 PID 证明 PostgreSQL 已停止。

二进制契约盘点在 `native-contract-inventory.json`：176 项，`getWeather` 已实现，`verified=false`，整体状态仍为 `IMPLEMENTED_NOT_REVIEWED`。尚未验证真实 Open-Meteo 服务可用性、Web/iOS 页面联调、真机行为、独立 review 或生产部署；均不属于本次 backend endpoint 的验收证据。

完整实现文件、任务证据与外部构建二进制的 SHA-256 清单见 `SHA256SUMS.txt`；清单记录 base HEAD、tracked diff digest 和可复现的条目聚合算法。报告中的二进制哈希路径为该清单。

交给 reviewer 优先检查：

1. Weather query 在通用 query 规范化之前拒绝未知字段，以及 handler Bearer 鉴权边界。
2. provider host 固定表、test-only loopback override、timeout/body cap、部分 AQI 失败与 24 小时 stale 上限。
3. 当前当地小时起始、跨午夜两日请求及空气质量 UV 按时间戳关联的语义。
