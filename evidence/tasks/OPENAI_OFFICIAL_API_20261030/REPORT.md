# OpenAI 官方 API、默认模型与定时日报

任务：OPENAI_OFFICIAL_API_20261030。实现登记：**IMPLEMENTED_NOT_REVIEWED**；部署状态：**DEPLOYED**。未自行登记正式 ACCEPTED。用户明确授权测试通过后直接部署，并随后授权提交到 GitHub，要求不得上传密钥。

## 结果

- 默认文字/图像 LLM 与 agent 使用 OpenAI 官方 API 的 `gpt-6-luna`。Web 保留每用户、每功能的显式模型/来源选择；交互日报默认 AMD `DeepSeek-V4.1-Flash`。
- 定时日报通过独立 Go scheduler/worker 与现有 PostgreSQL TaskExecution/TaskOutbox、租约和 fencing 执行，只领取内部 scheduled 日报。固定 AMD，不继承交互选择，不领取普通聊天、OCR 或语音任务。
- 按家庭时区处理已结束的昨日。并发调度在家庭事务锁内去重；已有日期日报不重复生成，沿用每宝宝每日一份及用户显式手动生成可替换同日版本的协议，不新增第二套日期存储。
- 失败及下一次执行时间持久化；暂时错误持续指数退避并带 jitter，尊重 Retry-After。供应商 key/config 错误保持同一 task/date queued，10–11 分钟后继续等待修复；用户/家庭/宝宝权限或非法输入错误停止。普通 AI 不解除原尝试上限。
- 定时报告经完整 JSON 校验后保存，采用 `overallRating` 和 Go 列表的 `targetDate` wire；Web 独立展示生成时间与 AMD 来源，不冒充当前统计或缓存新鲜度。不发原始部分 JSON delta。
- `.gpt` 从未打开或输出给模型；仅由程序按用户指令直接使用。该文件及 `.env.openai.local` 均为 0600、Git ignored、未被追踪。配置/日志/证据不包含其值。

## 基线与范围

服务端工作基线：`codex/llm-feature-preferences`，HEAD `99105020eab8e786c2627ec921bad3ee2e6ccf8e`。已有 dirty 清单见 `baseline-status.txt`。Web 原工作区 HEAD 为 `7a781995`；当前线上 10/27 源码不同于 10/24 发布 manifest，因此使用实际 live 公开源码白名单建立独立候选，再只叠加本任务 donor。

源码清单/hash：`task-source-files.json`、`web-official-donors.json`。差异：`diff/server.patch`、`diff/web.patch`。保存过 task-entry snapshot 的文件按该基线比较；`ai_run_commands.go` 与 `native_processors.go` 的 HEAD 差异包含既有 dirty 上下文，未将其全部归为本次新增。未重置或清理原工作区。

隔离候选：`/tmp/growdesk-openai-defaults-web-20261030`。只复制公开源码、依赖和六个公开参考 catalog；没有复制环境文件、私有 profile、数据库、上传、备份或运行数据。三个仍在 live 编译清单中的 OAuth 发现路由源码由对应 hash 验证的归档补齐，未恢复已删除的其他路由。依据见 `live-source-baseline.json`、`web-source-baseline.json`、`web-recovered-compiled-sources.json`。

## 验证与失败记录

每条检查的原始命令、退出码、时间及隔离说明均保存在同名 `.json` 与 `.txt`：

| 证据 | 最终结果 |
| --- | --- |
| `backend-build`、`typecheck-final` | exit 0 |
| `ts-unit-verified` | 169/169，无 skip，exit 0 |
| `lint-verified` | exit 0 |
| `go-runtime-packages` | `./cmd/... ./internal/...` 全部 race 通过，exit 0 |
| `go-focused-final` | 最终 provider/Passport/日报 race 定向测试 exit 0 |
| `daily-owned-final` | 最终发布二进制 + owned test_ PG/Redis + loopback AMD，exit 0 |
| `web-final-build` | 独立 Next production build/typecheck/postbuild exit 0 |
| `web-final-unit` | 18/18，无 skip，exit 0；含真实 Go serializer synthetic fixture |
| `launcher-tests-final` | 5/5；仅临时虚拟密钥/环境，exit 0 |
| `official-model-metadata.json` | 程序使用文件引用执行官方模型 GET，HTTP 200，无内容生成 |

owned 日报集成覆盖并发调度去重、独立日期不互相阻塞、AMD-only 请求、429 Retry-After 落库、超原 max_attempts 继续重试、401 虚拟 key 修复后同 runId 恢复、成功日报不重做、通用/专用 worker 互相隔离、报告持久化及无 raw text_delta。连接 guard 与测试资源清理沿用独立 test_ runner。未用真实家庭、生产凭据或真实推送验证业务行为。

失败没有被跳过或吞掉：根 `go test ./...` 曾把既有 `evidence/tasks/PASSPORT_TTS_FIX_20261023/source-overlay` 当成不完整包，导致 undefined 编译失败；已保留 `go-unit.*`，实际运行包全部另行通过。TS 全套首次暴露旧 VM loader 未注入真实 adapter/model-info 导入，已补齐真实实现并重跑全部通过。Next 首次 typecheck 暴露 live 源码副本漏了仍已编译的发现路由，已按归档及 live 路由清单恢复并完整重建；没有跳过类型检查。首轮 lint 与测试失败日志均保留。

## 部署

冻结包 `/tmp/growdesk-openai-defaults-release-20261030`：4538 文件、4 个内部链接，均逐项 hash 审计。`release-manifest.json` SHA256：`a4a6695774793ea41bee82f650f328ae57c08cf28a9a8765f96f028e251b4e9e`。

部署目录：`/home/ubuntu/growdesk/openai-defaults-releases/20261030-a4a669577479`；Web Build ID `kYl_9uExdjAPBXwY-0FOh`。部署器 `deploy/openai-defaults.py` 只新增本次 systemd drop-in/worker unit；失败自动回滚，回滚在任何服务操作前校验文件仍归本次管理。

主 API 保留原已运行的语音/TTS二进制和 warm 启动链，仅通过受控 launcher 选择官方 Chat Completions 与 GPT-6 Luna；源码中的新 Go Responses adapter 未冒充已替换到该主二进制。新日报使用单独已测 Go 二进制。不执行数据库迁移。

部署后：Web PID 3208291、API PID 3208244、日报 worker PID 3208386，均 active；原 TTS PID 1238 保持不变；首次正常日报入队服务 exit 0。原 `baby-panel-daily-summary.timer` 04:00 / 16:05 UTC 计划保留，只将其 service 从旧 Web no-op 改到持久 scheduler。

公网 settings、daily-summary、OAuth 发现接口正常；匿名 preferences、日报 API、MCP 保持 401。settings 引用的 21 个脚本均与冻结产物 hash 一致。见 `public-deployment-check.json` 与 `deployment-result.public.json`。没有登录真实账号、读取临床内容或向生产写入合成测试记录。

审批曾拒绝“启动器读取私有 profile 再另行导出 AMD key”的方案，该方案没有执行且不在产物中。实际采用现有 Web 进程已经加载的 profile 对象内复用 AMD alias；独立 worker 只使用既有受控环境里明确绑定 AMD endpoint 的凭据。未扩大私有 profile 文件读取范围。

回滚：

```sh
sudo -n python3 deploy/openai-defaults.py rollback
```

回滚只去掉 receipt/hash 匹配的本次增量配置并恢复旧启动入口，不删除日报、任务、用户选择或其他业务数据。receipt 在 `/var/lib/growdesk-openai-defaults/20261030/receipt.json`。

## GitHub 交付与密钥排除

推送准备使用独立 `codex/openai-api-defaults-20261030` 工作区，分别基于两仓库最新 origin/main；只纳入本任务与不可缺少的 LLM 选择/路由基础，不上传原工作区无关 dirty。提交前按明确文件清单检查敏感路径与新增内容；`.gpt`、`.env`/备份、私有 profile、数据库、上传和运行数据均排除。Web 已推送提交 `d9b1167a619754e2c6a8dbb5d614ed7d0cb68fce`；服务端同名功能分支由本报告所在提交交付，最终提交 ID 见 Git 历史。

真实内容生成、真实家庭浏览器操作、硬件语音操作未作为本次自动化验收；账户计费权益以供应商实际授权为准。当前结果不代表整个后端迁移、所有历史 dirty 工作或完整产品的正式接受。

### 干净提交树验证

服务端提交树基于最新 origin/main `516371a5959e11db865969cd0b2f9aa42be9bfa2`，52 个任务/必要 LLM persistence 前置文件、59 个纯文本证据与 1 个 Git patch 格式属性文件，共 112 文件。全 TS build/typecheck/contracts 生成、26/26 provider/serializer 测试、Go 定向 race、owned PG/Redis 的偏好 HTTP 隔离与持久化、最终独立日报集成均 exit 0。只摘取 LLM preference、provenance 与契约/迁移必要闭包，未纳入其他 MCP/OAuth、food、auth dirty。

Web 提交树基于最新 origin/main `422861a40295a7e174e01bcca014955c0fd182b1`，39 个任务/必要 LLM 路由、选择、设置和 retry 前置文件。干净树 tsc、20/20 定向测试、Next webpack 完整构建、lint 与 diff 检查均 exit 0。Turbopack 因隔离 worktree 的外部 node_modules symlink 限制未能构建，完整 webpack build 已通过，未跳过类型检查。

最终两份清单分别为 112 与 39 文件，敏感路径和凭据扫描均 0 findings。两处被识别的合成测试字面量已明确改为 test_ 前缀；扫描不输出任何匹配值。未上传 .gpt、环境文件及备份、私有 profile、数据库、生成客户端、node_modules、运行数据或二进制。原工作区和无关未提交文件保持原样。
