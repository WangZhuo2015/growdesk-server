# Go 后端 + 现有 Web 上线交接（本地 Agent 执行版）

核对日期：2026-09-24。准备 PR：[growdesk-server #12](https://github.com/WangZhuo2015/growdesk-server/pull/12)。

**当前结论：NO_GO，尚不能切换生产流量。前端已整合，Go 业务仍不完整、生产启动被拒绝，恢复分支也尚不能编译。本文件交接的是“补齐、生产化、验收、迁移、切换”全过程，不是假定功能已经完成的一键部署脚本。**

用户已要求上线新 Go 后端和新前端，并授权完成必要的准备工作。执行者应继续修复代码和验证，不要在发现已知阻塞后只返回一句“不具备上线条件”；但也不能跳过阻塞直接切流量。保留旧 Web 页面、URL、交互和数据，不以禁用原功能、返回空成功或回退本地状态伪装适配完成。

## 0. 给本地 Agent 的任务入口

> 你负责完成 `WangZhuo2015/growdesk-server` 原生 Go 后端与 `WangZhuo2015/baby_panel_for_cecilia` 的上线。先读完本文，检查本地仓库、未提交工作、远端 PR 和真实部署拓扑。以最新候选为基础小步提交，优先恢复并补齐原生运行时、剩余 Web 适配和生产配置。每步记录实际 SHA、命令和结果。已有用户授权，无须为已明确的目标反复请求确认；真实缺失的凭据或部署目标不能凭空猜测。遇到失败继续在隔离环境修复，不得通过跳过测试、删除接口或降低权限检查取得绿灯。代码、数据、附件、离线旧客户端、停止旧写入和恢复演练全部验收后，才按本文执行生产切换。最终更新 PR 和同一份交付报告，区分“已部署”“仅预演”“仍阻塞”。

本次远程会话已完成：

- 合并 Web #23、#24 到 `codex/web-parity-20260919`，没有合并 main、改写历史或部署服务器。
- 新增只读源码/二进制预检 `scripts/release/go_launch_audit.py`、14 项回归测试和 `Go launch audit (not deployment)` 工作流。
- 实际构建候选 API 并重新取得完整缺失接口清单；实际编译未合入恢复分支，定位到四个缺失符号。
- 本文提供统一交接入口。当前会话的本地执行环境初始化失败；证据来自实际 GitHub Actions，不包括 SSH、生产迁移、本地完整测试或 benchmark。

## 1. 不可变检查点与仓库归并

| 对象 | 已核对版本 / 状态 |
| --- | --- |
| Web 候选 | `c3582203f0577f0b2b31d46f5157d3b5308361f1`，包含 #22/#23/#24 |
| Web #23 合并 | `e65d021c04d40488394dc2fe0f5d69bd7ee2eb45`；原受测 head `8aadb7bb0800fd490cf144d498554ec1c93ae174` |
| Web #24 合并 | `c3582203f0577f0b2b31d46f5157d3b5308361f1`；原受测 head `80a728bb22082aa02e1b18c48b1215ef0e6166bf` |
| Go 业务候选 | `3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb`，#10/#11 已合入，130/151 注册操作 |
| 本次准备分支 | `codex/go-launch-handoff-20260924`，从上述 Go 候选建立；没有补写业务处理器 |
| 准备工具受测检查点 | `1659ba11488c38faf0e1e7d878cd888b8deba21e`，本文在其后提交；最终文档 SHA 以 PR #12 与制品中的 `server-source-sha.txt` 为准 |
| 未合入运行时 | `codex/go-web-runtime-20260923` → `994a6e4c21167aacf80b7609175a0d1979462668` |
| 未合入恢复备份 | `codex/go-runtime-recovery-20260923` → `bbae86fb28b606d052bbd14ebe1ce03c366304c2`；与上项可能共享实现，不能重复导入 |
| 后端 main | `80e999895a2c9410813ef3ffd730876bca51013b`；与候选分叉，不代表最新 Go |
| 冻结 TS 契约参考 | `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4` |

这些 SHA 是接手基线，不保证接手时远端仍未变化。执行 `git fetch`、`git status --short`、`git worktree list` 后重新确认。不要覆盖用户本地未提交的完整实现：先检查项目 worktree 和已知恢复位置，复制保护源码并比较，再逐模块整合。不要使用 `reset --hard`、`clean -fd` 或删除恢复分支来制造干净工作区。

优先从最新候选建立独立上线分支。恢复分支只能作为代码来源，不能直接设为部署版本。此前候选相对 main 为候选独有 293 个提交、main 独有 1 个；重新检查该 main 独有改动，保留必要修复。完成后以正常 PR 归并，不强推 main，也不为了部署标签而丢失另一侧提交。首次发布可固定受审查的不可变候选 SHA，不能使用会移动的分支名代替制品版本。

## 2. 本次真实验证结果

Web 最终合并版本 `c3582203…` 的 push 工作流已全部结束成功：

| 工作流 | 运行 |
| --- | --- |
| CI | [35962556672](https://github.com/WangZhuo2015/baby_panel_for_cecilia/actions/runs/35962556672) |
| Go Web transport | [35962556677](https://github.com/WangZhuo2015/baby_panel_for_cecilia/actions/runs/35962556677) |
| Native Go Web parity | [35962556697](https://github.com/WangZhuo2015/baby_panel_for_cecilia/actions/runs/35962556697) |

范围包括完整既有 npm test、静态检查、构建、传输回归、真实 Next→Go→PostgreSQL/Redis 和 Chromium 登录/通知场景。**不是所有页面、所有营养交互、离线、S3 与推送验收。**

准备工具检查点 `1659ba1…` 的 [Go launch audit 35962998175](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35962998175) 结果：14 项测试成功；候选 Go API 编译成功，预检正确返回 NO_GO；固定恢复分支实际编译失败。失败不等于 CI 已豁免，不能强行当作发布通过。

恢复分支编译日志指向 `internal/backend/native_processors.go`：

```text
23:12  s.executeNativeExport undefined
25:12  s.executeNativePush undefined
341:6  nativePushConfigured undefined
352:7  nativePushPlatformConfigured undefined
```

这四项只是此次编译器已报告的问题，不是全部待办。禁止用空函数、恒真配置函数或跳过执行器补齐编译。本文后的提交必须重新记录精确 HEAD 验证，不能把上面的工具检查点当作未来业务实现已通过。

## 3. 当前不能上线的具体原因

**运行限制。** `internal/backend/config.go` 的 `validateNativeRuntime()` 要求 experimental=1，仅接受 test/development，HTTP 必须是 127.0.0.1，并强制 PostgreSQL 使用非默认端口、`test_` 角色/库；Redis 也强制隔离回环端口。`NewServer` 同样使用这些保护。`internal/backend/object_store.go` 对预览桶、凭据和地址还有独立约束。把生产库改名为 test_、伪装 development 或删除校验，都不是生产化。

**部署入口仍是 Node。** 根 `Dockerfile` 最终执行 `node apps/api/dist/server.js`；`deploy/compose.yaml` 的 api 使用该 Dockerfile，内部 3080、宿主回环默认 3180，未定义 Go Worker/Scheduler。直接照旧 `compose up` 启动的不是新 Go 后端。

**后端仍缺 21 个操作。** 附录列出本次编译清单；包括任务命令、快照、同步写入、账户及 OAuth/MCP。仅返回“已排队”不代表 Worker 完成了任务。

**Web 仍有能力围栏。** `lib/growdesk/bridge-policy.ts` 中 Go 模式阻止 AI/语音/OCR/PAT 等入口；动态 AI job 路径也受限。原 #24 的补剂产品/计划乐观并发适配没有合入当前收敛版本。不能只移除 501 或把 TS 本地 Map/JSON 重新接回来。

**迁移和发布证据仍缺。** 现有 CI 未证明最终生产数据、历史附件、旧离线客户端和恢复路径全部正确。仓库里的 `docs/GO_COMPLETION.md`、部分部署手册仍记载早期 86/151 或 foundation 阶段；以实际源码和本次生成的 inventory 为准，不把旧文档当现状。

## 4. 本地开发顺序与完成标准

### A. 收敛原生运行时与缺失接口

先比较候选、两个恢复分支和本地未提交源码；只移植需要的实现，保留较新授权、事务和附件修复。重点文件：`native_tasks.go`、`native_processors.go`、`ai_run_commands.go`、`native_snapshots.go`、`sync_commands.go`、`native_migrations.go`、`native_object_cleanup.go`，以及 `cmd/growdesk-{worker,scheduler,migrate}`。逐项对照真实注册入口，不以文件存在代替接口已接通。

实现导出和推送，随后补齐账户、OAuth/MCP 与其注册：导出限定本人和当前权限、资源有界、不能打包环境文件或其他家庭资料；推送使用真实完整 WebPush/APNs 协议，失败/限流/过期订阅可观测且有界重试。凭据通过安全配置注入，不把生产 token 写进测试夹具。

Worker 的领取、租约续期、执行代次、取消、超时、重试和结果写回都必须有真实数据库测试。失去租约的旧 Worker 不能写回；进程崩溃后任务可恢复，重复领取不重复业务写入。Scheduler 要防止多实例重复调度、跨家庭数据混入和时间区间遗漏。迁移入口是独立的一次性受控作业，API 启动不自动升级生产 schema。

OAuth/MCP 必须验证 PKCE、精确 redirect URI、授权码单次消费、refresh 重放撤销、scope 收窄、真实账号/家庭/宝宝权限。浏览器 BFF Cookie 和外部 Bearer 的授权语义分别处理，不能把 expected-user 头当身份。补齐旧 `/oauth/*`、`/api/oauth/*`、`/mcp`、`/.well-known/*` 的明确映射与 issuer/audience，一并检查实际调用方，而不只做几个元数据接口。

### B. 完成剩余 Web 适配和并发写入

保留 #22 的服务端 readAt、本机隐藏语义、expected-user 检查、multipart 冲突校验、ABA 身份切换失效、授权旧图片和原生时间线详情校验。保留 #23 的固定上游、无隐式写重试、响应字节/超时限制和流取消。保留 #24 的喂养表单/快捷奶粉作用域。

补剂产品和计划：显式 extended DTO 返回观测版本，UI 提交 baseVersion；更改频率保留原剂量，不能使用 `Number(value) || 1` 偷换值。相同版本的两个客户端应一次成功、另一次 409；冲突展示和重载明确，不自动覆盖。默认 legacy DTO、decimal 字符串、null/缺字段/false/0 不变。先真实 Go/PostgreSQL 回归，再覆盖实际弹窗、第二家庭/第二宝宝和快速切换。

AI、语音、OCR、日报、PAT 的 Web 路由接到已验证的原生持久化和执行链路后，才逐项解除对应围栏。SSE/轮询需验证断开、恢复、事件顺序和取消，不把后台继续执行的任务误记成取消成功。全文搜索旧 SQLite/JSON/Map 的业务写入入口，区分开发测试工具和仍可达的生产路径；不要静默回退到 TS 后端。

### C. 实现正式生产配置和 Go 制品

为 production 单独实现强校验，保留 test/development 的隔离约束和回归。要求独立强 JWT/会话密钥、明确外部 HTTPS 基址、受信任反代、数据库非超级用户、必要 schema/迁移版本、Redis 鉴权、私有对象存储和外部请求预算。外部网络使用正确 TLS 验证；可信同主机容器私网可以明确选择无 TLS，但不能把它扩大为公网明文或关闭证书验证。

增加经过测试的 `deploy/Go.Dockerfile` 与 `deploy/compose.go.yaml`，或者明确的原生二进制 systemd 部署。本交接不包含这两个尚未实现的生产文件。推荐保持 Go 单体 API + 独立 Worker/Scheduler；打包编译好的 Go 可执行文件到精简非 root 镜像不违背二进制交付目标。Next.js 仍需要 Node；不要求把 Web、迁移工具也改成 Go。

制品应覆盖 API、Worker、Scheduler、迁移器；每个入口都能报告源码版本。固定基础镜像 digest、依赖锁、目标架构，包含运行所需 CA 证书和时区数据，设置只读根、最小可写目录、非 root、graceful stop、日志轮转、进程资源预算。不要把故障恢复分支的制品标成 production。

## 5. 复现、构建与验收命令

以下命令先在干净的隔离 worktree 中执行；变量是本地已核实的绝对路径。凭据不要在 `set -x`、日志或 shell 历史里展开。不要从生产目录加载 .env 来运行测试。

```bash
set -euo pipefail
umask 077
: "${SERVER_ROOT:?set absolute backend worktree path}"
: "${WEB_ROOT:?set absolute Web worktree path}"
EVIDENCE="$(mktemp -d "${TMPDIR:-/tmp}/growdesk-release.XXXXXXXX")"
export EVIDENCE

cd "$SERVER_ROOT"
git status --short
git rev-parse HEAD
export GOFLAGS=-mod=readonly
export GOTOOLCHAIN=local
go version                         # 当前仓库 CI 固定 1.27.1；不是“自动用 latest”
go mod download
go mod verify
git diff --exit-code -- go.mod go.sum
go vet ./...
go test -race -count=1 ./...
CGO_ENABLED=0 go build -trimpath \
  -ldflags="-s -w -X main.revision=$(git rev-parse HEAD)" \
  -o "$EVIDENCE/growdesk-api" ./cmd/growdesk-api
"$EVIDENCE/growdesk-api" --version
"$EVIDENCE/growdesk-api" --contract-inventory > "$EVIDENCE/operations.json"
python3 scripts/go-coverage.py "$EVIDENCE/operations.json" --require-complete
```

当前版本会在完整性检查失败；这是实际待办，不要追加 `|| true`。构建的本机架构二进制用于本机验收；发布时根据目标 `uname -m` 选择 linux/arm64 或 linux/amd64，分别构建并在目标架构实测。不要因为主机名字有 Ampere 就猜测架构。CGO-disabled 发布构建和带 race 的测试是两步，不把 `CGO_ENABLED=0` 全局套到 race 测试上。

审计工具从本次准备分支读取；它可以检查另一个独立、已经构建的发布 worktree：

```bash
: "${HANDOFF_ROOT:?set checkout containing this document and audit tools}"
python3 -B "$HANDOFF_ROOT/scripts/release/go_launch_audit.py" \
  --server-root "$SERVER_ROOT" --web-root "$WEB_ROOT" \
  --binary "$EVIDENCE/growdesk-api" \
  --output "$EVIDENCE/launch-audit.json"
```

审计是只读元数据检查，NO_GO 返回非零；通过时也仅为 `SOURCE_AUDIT_PASS_REQUIRES_ACCEPTANCE`，`productionApproved` 始终 false。不能删除源码标记、建立空部署文件或伪造版本来消除警告。输出必须在源 worktree 之外且不存在。将报告绑定到实际二进制和最终提交，不用文档中的旧 SHA 代替。

Web：

```bash
cd "$WEB_ROOT"
git status --short
npm ci
npx prisma generate
npm run typecheck
npm run lint
npm test
BUILD_REVISION="$(git rev-parse HEAD)" npm run build
node scripts/review/check-growdesk-runtime.mjs
```

完整后端回归沿用 `.github/workflows/go-backend.yml`、`go-food-library.yml`、`go-completion.yml`、TS backend 与 migration-integrity 的实际命令；不能只运行注册计数。保留冻结参考并检查实际 HTTP、数据库副作用与已知安全差异。新增 runtime 的故障注入必须进入正式 CI。

跨仓联调沿用 Web `.github/workflows/go-web-parity.yml`：

```bash
cd "$WEB_ROOT"
python3 scripts/review/check-native-boundaries.py \
  --server-root "$SERVER_ROOT" \
  --binary "$EVIDENCE/growdesk-api" \
  --report "$EVIDENCE/web-native-report.json"
```

执行前读脚本：它使用受管理的独占 PostgreSQL/Redis 和固定后端。Web 的 `scripts/review/go-api-baseline.json` 目前固定 `3e0578ba…`；最终 Go 代码改变后，需要审查并更新到实际最终后端 SHA，再执行对应工作流。不能只改 pin 而不重测。准备 PR 只增加文档也会造成 SHA 与旧 pin 不同；该提示是在要求准确配对，不是在证明业务代码有差异。

每个最终发布提交都重新运行全部适用门禁。`fetch_commit_workflow_runs` 的某些客户端只列 PR 事件，合并后 push 的检查需另外核对；不可把“列表为空”当检查成功。

### 必须补齐的验收矩阵

| 范围 | 最低实测要求 |
| --- | --- |
| 身份与写入 | 注册/登录/登出/过期/撤权；多家庭多宝宝；只读成员；重复请求；版本冲突；事务失败整体回滚 |
| 原页面 | 喂养、睡眠、尿布、辅食、营养、生长、医疗、疫苗、家庭、图书、发育、天气、通知的读取和真实编辑流程；原路径/布局不变 |
| 任务与外部接入 | AI 执行及确认/取消/重试、语音/OCR/日报、OAuth/MCP/PAT；重启恢复、断流续读、慢上游、重复投递 |
| 附件 | 旧 URL 映射、私有字节下载、上传完成、删除失败恢复、跨家庭/撤权、哈希与 MIME；不能只 HEAD 成功 |
| 浏览器生命周期 | 刷新、双标签页、A→B→A、切账号、旧 JS/Service Worker、IndexedDB/outbox 待同步记录；失败不能显示已保存 |
| 生产配置 | 使用正式 production 配置启动受隔离的非生产数据环境，API/Worker/Scheduler 均可用；再验收目标架构制品和反代 |

现有 Chromium 测试会阻止 Service Worker，故不提供离线验收。另建允许真实 SW/IndexedDB 的场景，不在旧测试里删除安全断言。外部协议先用受控测试服务；真正上线前，在指定测试账号/设备上完成必要的小范围真实连通性检查，避免向全体用户发送测试推送或无界付费 AI 请求。

## 6. 目标部署拓扑与配置合同

建议沿用单机私网拓扑，确认服务器容量后实施；这不是已经部署的状态：

```text
用户现有 HTTPS Web 域名
  → 已有反向代理（仅修改该站点的受控 upstream）
  → 新 Next.js Web/BFF
  → 私网 Go API
  → PostgreSQL / Redis / 私有 S3

Go Worker、Scheduler → 同一受控持久层及必要外部服务
独立迁移器 → 仅发布窗口使用的 migration role
```

Web 不直接拥有新 PostgreSQL 写权限，浏览器不持有数据库、S3 或后端签名密钥。当前附件上传由 BFF 向 Go 签名的私有存储 URL 做 PUT，所以 **Web 服务也必须能访问那个私有存储地址**；不能只让 Go 加入 storage 网络。下载仍经授权 BFF/Go，不公开桶。

不要把 `127.0.0.1` 当成另一个容器或宿主机。Compose 部署下可使用受控服务 DNS，例如 `http://go-api:3081`，但这需要先完成 Go production 网络配置；当前预览只接受 127.0.0.1，不能直接套用该示例。

Web 的运行时配置合同：

```dotenv
NODE_ENV=production
GROWDESK_ENABLED=1
GROWDESK_BACKEND=go
# 删除/清空遗留的 GROWDESK_API_URL；非空显式值会覆盖下面的 Go 专用 URL。
GROWDESK_GO_API_URL=http://go-api:3081
GROWDESK_WEB_ORIGIN=https://替换为核实后的原Web域名及必要端口
HOSTNAME=0.0.0.0
PORT=3000
```

这只是生产化后的配置示例，不是当前可直接启动的生产 .env。域名占位必须替换；Go URL 是服务器私网地址，不是 NEXT_PUBLIC 变量。Next 的 `NODE_ENV=production` 与 Go 的 `GROWDESK_ENV=production` 属于不同进程，不要混淆。

后端必须核对的已有变量：

| 配置 | 要求 |
| --- | --- |
| `GROWDESK_ENV`、`HOST`、`PORT` | 正式生产校验实现后使用 production；监听与 Compose/反代一致 |
| `DATABASE_URL` | 明确 `postgresql://`、角色、密码、主机、库；应用角色非 superuser；跨主机 TLS 验证 |
| `REDIS_URL` | 明确鉴权、主机、端口、db；与旧队列隔离，noeviction 与持久化策略经验证 |
| `JWT_SECRET`、`SESSION_ENCRYPTION_KEY` | 独立强值，持久保存；已有值不得每次发布重新生成；加密格式和密钥轮换单独设计 |
| `INVITE_SECRET` / `INVITE_CODE_PEPPER` | 使用当前兼容语义，不能因部署丢失有效邀请 |
| `PUBLIC_BASE_URL` | 实际可信 HTTPS 对外基址，校验 OAuth issuer/回调/资源 audience |
| `DB_POOL_MAX`、`HTTP_MAX_CONCURRENCY`、`HTTP_TIMEOUT_SECONDS` | 显式总预算，API 与全部 Worker 连接之和不能挤爆数据库 |
| `S3_BUCKET`、`S3_REGION`、`S3_ENDPOINT` | 明确私有桶与私网或受保护 TLS 地址 |
| `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、可选 `AWS_SESSION_TOKEN` | 实际 Go S3 读取这些名称；应用使用最小桶权限，不直接复用 MinIO root |
| AI/ASR/OCR、WebPush/APNs 配置 | 从最终实现读取真实名称，配置到实际执行进程；Web 公钥与发送端私钥配对 |

Web 现有 Prisma 是旧 SQLite 模型：**不能把它的 DATABASE_URL 直接改成 Go 的 PostgreSQL URL。** 构建阶段保留必要生成步骤；Go 模式运行时不应访问旧业务库。通过只读文件系统/受控不可用旧库及真实功能测试证明没有回退，不挂载生产旧库来掩盖缺口。

## 7. 目标主机预检（历史线索，不是本次 SSH 验证）

仓库 `deploy/HOST_RUNBOOK.zh-CN.md` 记录过 `ubuntu@ampere.zwang.fun`、IP `161.33.201.230`、`/home/ubuntu/growdesk`，以及 `https://ampere.zwang.fun:8443`。这些是 2026-09-12 的线索。本次未验证主机在线状态、DNS、端口、凭据或资源，接手时以用户本地 SSH 配置、known_hosts 和实际主机为准。

历史连接形式是 `ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun`。保留 host-key 验证，端口按已有配置，不因失败关闭验证、改 sshd 或重启网络。

先只读检查架构、CPU、内存、磁盘、监听端口、容器 names/image/ports、Compose 项目和相关 systemd 单元。不要输出完整 `docker inspect` 环境、`/proc/*/environ` 或明文 .env。旧系统/预览系统可能已存在真实导入数据；“尚未正式上线”不意味着库和卷可以清空。

历史工具和路径：`/home/ubuntu/growdesk/bin/docker-compose`、`DOCKER_CONFIG=/home/ubuntu/growdesk/docker-config`、`/home/ubuntu/growdesk/shared/runtime.env`、`/home/ubuntu/growdesk/releases/<SHA>/`。确认后才使用；保留原密码、目录权限和其他项目。旧 Compose 明确设置了全局 named volume/network 名称，因此 **只换 Compose project name 并不能保证隔离**；演练必须使用真正独有的卷/网络/数据库/桶和归属标识。

历史反代为 sing-box 管理的 nginx，配置可能是 `/etc/sing-box/nginx.conf`，include 为 `/etc/sing-box/nginx.d/growdesk.conf`，且 PID 文件曾为空。实际读取 master 参数与可执行文件，使用同一 binary/config/prefix `-t` 后 graceful reload；不要盲目 `systemctl restart nginx` 或修改其他站点。上线需要调整原 Web 站点时，只调整经确认归属的路由，不替换整个主配置。

资源配额先测量：Go API、Worker、Next、PG、Redis、S3 与原服务都计入。低 RSS 不等于整机有容量，不以提高并发数替代压测。可先采用保守连接池和 Worker 并行数，记录延迟/错误率/内存/队列积压后调整；本文不声称已做 benchmark 或节省了多少资源。

## 8. 迁移演练：先保证数据和可恢复性

先建立“谁仍可写”的清单：旧 Web/API、直接 API 客户端、MCP/OAuth/PAT、旧 Worker/cron/Scheduler、第三方回调，以及浏览器离线 outbox。维护页只限制 UI，不等于旧 API 和后台任务已停写；少数 GET 入口也可能触发任务，逐项检查。

在授权范围内生成一致性 SQLite 快照，而不是直接复制正在写入的数据库主文件并遗漏 WAL。使用仓库已验证的 snapshot 工具或 SQLite 在线备份接口；同时盘点 uploads、AI/语音本地 JSON、历史快照和所有数据库外状态。参考 [SQLite Online Backup](https://www.sqlite.org/backup.html)。生产数据保存在受限目录，按现有安全方案加密备份；日志和公共 GitHub artifact 只放数量、哈希和脱敏结果，不放儿童/医疗原始内容、用户名、密码哈希或 token。

对旧源和当前新目标分别备份。PostgreSQL 使用匹配服务器主版本的备份/恢复工具并保存必要角色与对象存储快照；仅有 pg_dump 文件不代表已恢复成功。参考 [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)。

在全新的隔离目标执行仓库迁移/materializer：保留账号密码哈希、家庭/宝宝权限映射、各记录时间/剂量/备注/版本和旧附件引用。对实际运行表逐字段对账，不能仅对导入回执或归档数量。检查未知非空源表、quarantine、未解析附件、对象字节/hash、删除状态、重跑幂等和部分失败恢复。已有迁移回执不能套用到新的源快照。

注意：当前 `verify_target.py` 的目标防护要求 Compose project `growdesk`、service `postgres`、指定 PG18.6 image、private `growdesk-db` network、无宿主端口，并固定查询 growdesk 数据库。新隔离拓扑若不匹配，先将工具改成显式且可验证的“本次资源归属”契约并补测试；不要伪造标签、删保护或让它误连现有生产容器。

先跑完整恢复演练到另一新目标，检查实际可登录、记录和附件可读、任务可恢复。记录实测恢复时长和切换后数据处理方案。不能用“备份命令返回 0”作为 rollbackRehearsal 的 passed 证据。

## 9. 最终发布证据与开关条件

发布至少需要三层结果，互相不能替代：

1. 源码/制品与功能验收：完整 native inventory、生产配置测试、全部适用 CI、真实 Web 页面/Worker/S3/外部接入验收；没有未解释失败。
2. `importIntegrityReady=true`：最终快照实际业务表、权限、附件对账通过。
3. `releaseCutoverReady=true`：与同一最终快照、同一最终 Web/Server 提交对绑定的五类真实回执通过。

现有 `scripts/legacy-import/release_gate.py` 要求：

| 回执 | 额外条件 |
| --- | --- |
| `pairedAcceptance` | `goldenPassed=true`、`browserPassed=true` |
| `attachments` | `unresolved=0`、`quarantined=0` |
| `finalWriterFence` | `writersStopped=true`、`finalSnapshot=true` |
| `incrementalReconciliation` | `pendingChanges=0` |
| `rollbackRehearsal` | `restored=true`、`freshTarget=true` |

每份回执均需真实 `passed=true`、`sourceDirty=false`、相同 archiveSha256、webCommit、serverCommit；manifest schemaVersion=1，checks 描述回执相对路径及实际 SHA-256。文件需受限权限、无符号链接、哈希可验证。验收实际产生回执，不能手工写一组 true 来让门禁通过。门禁验证提供的证据，不自动完成停写或恢复。

下面是现有校验命令，变量必须来自本次已完成迁移和实际目标核对，不是待替换的假证据：

```bash
: "${ARCHIVE:?immutable final archive path}"
: "${SOURCE_MANIFEST:?matching source manifest path}"
: "${TARGET_CONTAINER:?verified owned PostgreSQL container}"
: "${RECEIPT_DIR:?actual migration receipt directory}"
: "${RELEASE_EVIDENCE:?actual five-check manifest path}"
: "${RELEASE_REPORT:?new output path outside source worktrees}"
python3 scripts/legacy-import/verify_target.py \
  --archive "$ARCHIVE" --manifest "$SOURCE_MANIFEST" \
  --target-container "$TARGET_CONTAINER" --receipt-dir "$RECEIPT_DIR" \
  --release-evidence "$RELEASE_EVIDENCE" \
  --require release --output "$RELEASE_REPORT"
```

默认也是 release；`--require import` 不能作为允许切流量的结果。最终回执还应交叉核对 manifest 的两个 commit 确实等于待部署制品，不能只满足 JSON 内部相互一致。代码检查与最终停写可以分阶段，不必提前停旧服务等待开发。

## 10. 正式切换顺序（前述条件满足后执行）

**T0：保持旧服务正常，完成新栈预演。** 在新不可变 release 目录准备已受测制品和安全配置，先不让新栈消费旧生产队列或写旧生产库。与主机已有网络/卷重名时先核对，不能接管。记录旧 Web/API 镜像、源码、反代配置哈希和运行状态。

**T1：维护窗口与最终源快照。** 核实并阻断全部旧写入口和任务执行，等待/取消正在处理的任务并记录状态；浏览器旧 outbox 不能自动换账号重放。保留旧服务恢复能力。生成最终一致性快照和对象清单，执行已经预演的增量/最终迁移，对实际运行表和附件重新核对。若不能证明增量完整，继续维护而不是宣称零差异。

**T2：新目标上验收受限流量。** 执行唯一 migration 作业，成功后启动新 API，再启动与其 schema/任务协议匹配的 Worker/Scheduler，最后启动新 Web。只能有一个正式写权威和一套消费归属明确的队列。用指定验收账户完成登录、写入、修改、冲突、附件和任务闭环；确认日志/制品版本确实为 Go，不靠 HTTP Server 标头判断。严禁把业务秘密响应留在公共日志。

**T3：同源路由切换。** 完成最终 release gate，校验精确 nginx 配置后只切换目标应用的 upstream。通常保留用户原 Web 域名，旧 `/api/*` 仍先到 BFF；不得整体把这些路径转到不兼容的 `/api/v1/*`。OAuth/MCP/metadata 路径按照已测试的路由合同配置。动态身份/私有数据和附件保持 no-store；SSE 验证反代不缓冲且超时有界，见 [Next.js 自托管说明](https://nextjs.org/docs/app/guides/self-hosting)。

**T4：会话与旧客户端升级。** 当前 TS→Go BFF 刷新接管是单向的，不能随机分流两个刷新写端，不能把 Go 加密凭据降级明文换回滚。必要时使用已测试的重新登录流程。新 SW/version 发布不应强删尚未同步的合法记录；先隔离旧身份、保留待处理数据并提供重放/冲突方案。旧页面的迟到响应不能覆盖新身份。

**T5：观察与关闭维护。** 检查健康、错误率、尾延迟、RSS/CPU、连接池等待、任务积压/重试、附件失败、401/403异常、实际业务写入和同步；与切换前基线比较。正确性错误、越权、丢数据或持续任务失败立即恢复维护并按下一节处理。性能恶化以事前明确的预算/服务目标判断，不用临时挑一个漂亮 QPS 作为成功标准。

不要在正式迁移同时执行高负载 benchmark。上线验证通过后，在隔离数据/受控配额下比较同一业务语义的 TS 和 Go；排除 503/501、鉴权失败、冲突和幂等回执命中作为新写吞吐。

## 11. 回滚：切路由不等于恢复数据

| 发生阶段 | 可以做什么 | 不能做什么 |
| --- | --- | --- |
| 新系统尚未接受真实写入 | 停新写端，恢复已记录的旧站点 upstream；重验会话与任务归属，旧源仍是权威 | 假定 TS 能读取 Go 已改写的刷新凭据；让两个 Worker 同时消费 |
| Go 已经接受真实写入 | 先停止新增写入，保护新 PG/S3/任务和增量记录；优先回退到兼容同一新数据的旧 Go 制品或前向修复 | 直接切回旧 SQLite Web，造成切换后的新记录消失；只换二进制却忽略 schema/凭据格式 |
| 数据/schema 无法兼容回退 | 进入维护，在独立目标恢复备份并重放/对账切换后增量，验证无丢失后再恢复服务 | 覆盖现有目标、删除卷或未验证反向迁移；把发送过的推送当成可自动撤销 |

恢复需要同时考虑新产生记录、附件、用户/成员变化、任务副作用、会话加密和各版本 schema。没有可靠反向转换时，宁可保持维护并前向修复，不能声称“随时无损回退到旧 SQLite”。未经验证不要对生产 schema 运行 down migration。

禁止 `docker compose down -v`、`docker system prune`、全局停服务、删除历史备份/恢复分支、把其他项目卷作为测试卷。只停止本次可确认归属的进程和消费者，保留证据。停止服务本身并不删除数据；清理应在发布稳定且完成归属/保留期审查后单独进行。

## 12. 本地 Agent 最终应交付什么

将实现和测试小步提交，更新相应 PR；补齐实际生产部署文件、环境变量模板、迁移入口和 README，不保留互相冲突的“68/86/130/151 已完成”声明。准备 PR 中固定恢复分支的诊断 job 记录的是已知坏检查点；新实现完成后以显式受审查的新 ref 做新的完整验证，不将旧失败静默隐藏为成功。

在受限证据目录输出一份最终报告（公共 PR 只放脱敏摘要）：

```text
状态：BLOCKED / READY_FOR_CUTOVER / DEPLOYED / ROLLED_BACK
实际 Web commit / tree / image digest：
实际 Go commit / tree / API、Worker、Scheduler、migrate 摘要：
目标主机身份与架构核对：
production 配置验证与 schema 版本：
完整 CI、真实浏览器/任务/S3/协议测试结果：
最终源快照 hash、旧写入停止证据、实际运行表/附件对账：
恢复演练结果与实测恢复时间：
切换时间、路由版本、正式写权威、观察指标：
回滚是否实际执行、切换后新增数据如何保留：
仍失败/未测项及下一步（没有则明确写无）：
```

只有实际完成目标主机切换及上线后验收，才能写 DEPLOYED。只打包、PR 合并、健康接口 200 或 inventory 151/151 都不等于上线完成。

## 附录：本次实际缺失的 21 个契约操作

来自 `1659ba1…` 构建的 native inventory；业务代码仍与候选 `3e0578ba…` 相同。每项必须有真实实现和测试，不能通过建立占位处理器凑数。

| operationId | 方法与路径 |
| --- | --- |
| cancelAiRun | POST `/api/v1/ai/runs/{id}/cancel` |
| confirmAiRun | POST `/api/v1/ai/runs/{id}/confirm` |
| createAiRun | POST `/api/v1/ai/sessions/{id}/runs` |
| createDailySummaryRun | POST `/api/v1/babies/{babyId}/daily-summaries/runs` |
| createFamilySnapshot | POST `/api/v1/sync/families/{id}/snapshots` |
| createMedicalOcrRun | POST `/api/v1/medical/ocr-runs` |
| createTimelineEvent | POST `/sample/timeline` |
| createVoiceRun | POST `/api/v1/voice/runs` |
| deleteCurrentUser | DELETE `/api/v1/me` |
| exchangeMcpOAuthToken | POST `/api/v1/mcp/oauth/token` |
| executeSyncCommands | POST `/api/v1/sync/commands` |
| exportUserData | POST `/api/v1/me/export` |
| getFamilySnapshot | GET `/api/v1/sync/families/{id}/snapshots/{snapshotId}` |
| getGrowthRecord | GET `/sample/growth/{id}` |
| getOAuthAuthorizationServerMetadata | GET `/.well-known/oauth-authorization-server` |
| getOAuthProtectedMcpResourceMetadata | GET `/.well-known/oauth-protected-resource/mcp` |
| getOAuthProtectedResourceMetadata | GET `/.well-known/oauth-protected-resource` |
| handleMcpRpc | POST `/mcp` |
| retryAiRun | POST `/api/v1/ai/runs/{id}/retry` |
| revokeMcpOAuthToken | POST `/api/v1/mcp/oauth/revoke` |
| updateCurrentUser | PATCH `/api/v1/me` |

其中两项为 sample。它们计入当前冻结 151 契约，不允许静默删去以通过门禁；也不能为凑数而向生产公开不安全样例。若应退役，需显式契约变更、消费者检查和重新基线验收。OAuth 注册/授权、PAT 管理及其他旧 Web 路径可能还在此 151 之外，应按真实消费入口验收，不能把 21 项清单当全部产品需求。

### 关键源码依据

- [生产启动限制](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/internal/backend/config.go)
- [当前 API 入口和 metadata flags](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/cmd/growdesk-api/main.go)
- [默认 Node Dockerfile](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/Dockerfile) 与 [Compose](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/deploy/compose.yaml)
- [Go 对象存储配置](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/internal/backend/object_store.go)
- [当前 Web 能力围栏](https://github.com/WangZhuo2015/baby_panel_for_cecilia/blob/c3582203f0577f0b2b31d46f5157d3b5308361f1/lib/growdesk/bridge-policy.ts)
- [发布证据校验](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/scripts/legacy-import/release_gate.py) 与 [目标实际运行表对账](https://github.com/WangZhuo2015/growdesk-server/blob/3e0578ba5e7ba6dc4b00e04d931385bbc5fafddb/scripts/legacy-import/verify_target.py)

历史资料只用于溯源；上线必须以接手后实际复核的最终源码、制品、数据快照和目标主机证据为准。
