# Passport stream diagnostics

状态：`IMPLEMENTED_NOT_REVIEWED`。本任务增加服务端 stream 中断的安全结构化诊断；不能据此认定已部署，也不能确定本次物理设备断连的根因。

## 改动

- `internal/backend/server.go` 将实际的 stream 返回错误交给诊断 helper。
- `internal/backend/stream_diagnostics.go` 只输出 `streamType`、固定粗粒度 `errorClass`，以及 WebSocket close 帧中的数值 close code。分类覆盖 EOF/unexpected EOF、context 取消/截止、网络超时、关闭、连接 reset/aborted、broken pipe、WebSocket read limit、可安全匹配的 Gorilla v1.5.3 固定协议错误和 unknown。
- 不记录错误原文、WebSocket close reason、URL、地址、token 或 request 内容。协议文本只用于匹配固定 allowlist，不输出文本；sentinel 通过 `errors.Is` 识别，其他类型通过 `errors.As`。
- `internal/backend/stream_diagnostics_test.go` 覆盖 wrapped errors、HTTP 与 WebSocket stream 类型、unknown 秘密文本不进入日志、close reason 不进入日志、close code 仍为数字，以及 Gorilla 固定协议文本分类。

## 基线与冻结源码

`_baseline/server.go` 是实现前工作树副本，SHA-256 为 `4d41db891502714a548cb9656b1c5e593b5e0ab3d7262bb08a878a9e50a86337`。捕获时 HEAD 为 `516371a5959e11db865969cd0b2f9aa42be9bfa2`（`main`），目标 `server.go` clean；共享工作树其他既有修改和未跟踪文件保留。

`artifacts/source_snapshot/` 冻结了 190 个服务器源码/嵌入资源文件（155 个 Go 文件），包含既有 short-turn 152 项来源清单、当前 `server.go` 和两份 stream diagnostics 文件。旧 `source-before-152` / `source-after-152` 清单保存在 `artifacts/short-turn-source-before-152.json` 与 `artifacts/short-turn-source-after-152.json`；其唯一相对当前源码的预期哈希差异是 `internal/backend/server.go`。冻结副本的逐文件 SHA-256 在 `artifacts/source-manifest.json`。

## 验证

- 定向测试 `go test ./internal/backend -run '^(TestClassifyStreamInterruption|TestServeHTTPLogsSafeUnknownHTTPStreamError|TestServeHTTPLogsWebSocketCloseCodeWithoutReason)$' -count=1` — PASS（exit 0）；`git diff --check` — PASS（exit 0）。
- 从冻结源码、以清空继承环境的 `env -i` 执行 `go test -json -race ./... -count=1` — PASS（exit 0），darwin/arm64 共 346 项测试 PASS、4 项集成测试 SKIP、0 项失败。跳过的 `TestPassportFoodCatalogContextIntegration`、`TestPassportConfirmedRecordsIntegration`、`TestPassportConfirmationRevocationIntegration` 和 `TestPassportShortTurnWebSocketIntegration` 均要求隔离 PostgreSQL；本次未设置 `TEST_PASSPORT_DATABASE_URL`。Linux 专用 `_linux_test.go` 在 darwin/arm64 不参与测试构建，故本结果不代表 Linux 运行时验证。JSONL 日志及汇总位于 `artifacts/go-test-race.jsonl` 和 `artifacts/go-test-race-summary.json`。
- 从同一冻结源码用 `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../growdesk-api-linux-arm64 ./cmd/growdesk-api` — PASS（exit 0）；产物为静态 Linux/AArch64 ELF，SHA-256 `ad76c14be814ba45806457c380626eff6a9672abbe6deed6ffc73e2db6c79937`。
- 从冻结源码构建 `stream-diagnostics-darwin-arm64.test` — PASS（exit 0），再运行 `TestClassifyStreamInterruption`、`TestServeHTTPLogsSafeUnknownHTTPStreamError` 和 `TestServeHTTPLogsWebSocketCloseCodeWithoutReason` — PASS（exit 0）；测试二进制 SHA-256 `1f128cd8b512f29164ffce81b827ab1fdade188a3bf781671b35918c72dafe82`。测试运行日志在 `artifacts/stream-diagnostics-test-run.txt`。
- 为 root 的 Linux 环境额外交叉编译 `stream-diagnostics-linux-arm64.test`：`GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go test -c -run '^(TestClassifyStreamInterruption|TestServeHTTPLogsSafeUnknownHTTPStreamError|TestServeHTTPLogsWebSocketCloseCodeWithoutReason)$' -o ../stream-diagnostics-linux-arm64.test ./internal/backend` — PASS（exit 0）；`file` 确认为静态 ELF AArch64，SHA-256 `5109737af428b35f754ce0aa304a29ebf63bc29028d8a0d0eec91a7db295a4b7`。这是 backend 包测试二进制，包含该包全部测试代码；root 在 Linux 执行时需传 `-test.run='^(TestClassifyStreamInterruption|TestServeHTTPLogsSafeUnknownHTTPStreamError|TestServeHTTPLogsWebSocketCloseCodeWithoutReason)$'` 来限制运行范围。此 Linux 二进制尚未执行。
- 为保持离线构建，使用 Go 1.27.0 缓存工具链直接执行，并设置 module proxy/sumdb 为 off。首次 wrapper 调用在测试启动前因工具链校验失败；随后一次测试尝试在测试启动前发现冻结副本遗漏根 Go 包文件。两份失败诊断分别保留为 `artifacts/toolchain-resolution.log` 与 `artifacts/go-test-race-incomplete-snapshot.jsonl`；补齐根 embed 源和资源后，完整套件及三项构建均通过。

stream diagnostics 测试只验证错误分类与日志脱敏，不单独证明 Passport 认证/家庭权限。真实隔离数据库集成测试本次因未提供专用测试库而跳过；本地现有权限/guard 单元测试已包含在 346 项 PASS 中。未连接生产数据库、推送服务或外部 AI provider；未部署、未做 Linux 设备或 Passport 真机测试。
