# FAMILY_RECORD_PUSH_20261005 隔离持久化与推送验收

状态：`IMPLEMENTED_NOT_REVIEWED`。最终隔离运行满足 **21/21 项本卡判据**：19 项家庭通知场景、1 项 snapshot manifest API 回归、1 项 AI 既有 409 未退化的兼容性回归，包含 **233 次 HTTP 断言、63 次实际 Go native worker `--once`、23 次实际 webpush-go HTTP 请求**。AI 空附件同 clientMessageId 重放仍为原码已有的 409，**未通过 202 幂等重放验收**，原码失败证据保留。外部推送服务由本轮独占 loopback fixture 返回 201、503、403、410；没有连接生产或公网推送服务，没有证明物理设备系统通知已展示。

本子任务仅新增 `scripts/review/check-family-push.py` 和本目录的验收证据。Go 实现、迁移与 contracts 由实施代理负责，本验收未修改这些文件。协议依据源计划 02 §7.3、功能范围依据 04 §6.3；验证实施状态与 review、部署状态分开。

## 红 → 绿

- **先捕获原码红**：[首次原码报告](backend-84ff7262f462/persistence-report.json)。冻结原始 HEAD `516371a5959e11db865969cd0b2f9aa42be9bfa2` 后构建，真实注册、家庭邀请加入、宝宝授权、完整 PushSubscription 保存均成功；feeding HTTP 201，feeding record +1、family change +1，但 family notification task、notification、push delivery 都 +0，实际 worker 没有可发送任务，fixture 请求 0。脚本退出 **1**，失败代码 `family_notification_task_missing`，保留失败退出码。
- **最终脚本再核对原码红**：[原码复核报告](backend-37426b95194e/persistence-report.json)。同一原始 HEAD 归档，并实际执行原生迁移与迁移重放，14 次 HTTP 断言、1 次实际 worker。record、timeline、receipt、family cursor 各 +1，family notification task/outbox/notification/delivery 各 +0；退出 **1**。清理结果完整。
- **此前 18 组绿**：[18 组报告](backend-b4d8425ee110/persistence-report.json)，退出 **0**。这份报告验证此前源版本，随后 device overflow 和两个 metadata 读取接缝修复后不再作为最终源码证据。
- **最终修复绿**：[21 项报告](backend-e8c705a15195/persistence-report.json)，退出 **0**。冻结最终 Go/SQL/嵌入契约输入后构建 API、worker、migrate，实际 migrate 连续执行两次，0001–0004 均由 Go 原生迁移执行器应用并核对 checksum。19 项家庭推送、snapshot manifest 回归全部通过；AI 判据只证明既有 409 未退化成 metadata 500，不声称 202 replay 正常。
- 中间报告保留：[缺失 knowledge 嵌入输入导致构建失败](backend-43a38c880389/persistence-report.json)、[脚本 diaper 使用非法 `wet` 枚举失败](backend-4b6321a44477/persistence-report.json)、[最初完整 16 组通过](backend-09e9d2fe0815/persistence-report.json)、[未定义 `/tasks` 路径导致 harness 404](backend-4bb4b6bf26d7/persistence-report.json)。之后补全冻结输入、按契约改为 `pee`，未放宽 API 验证；最终 snapshot 测试使用实际公开契约，不新增路由。
- **既有 AI 重放红**：[原码 AI 探针](backend-a16999690900/persistence-report.json)。原始 HEAD 真实 session/run 创建 202，空 `attachmentIds` 的同 clientMessageId 重放返回 409 / `CLIENT_MESSAGE_CONFLICT`，期待 202 的探针退出 **1**。没有运行 AI worker。本卡不修既有空附件哈希差异，最终报告明确 `sameClientMessageReplay202Verified=false`。

最终 155 个源输入 SHA-256 清单保存在 green JSON 的 `source.inputs`；聚合 SHA-256 为 `2567c40b34781f84744bc817a6e95738d29d83d117d4ff1f75c7a7c8812715a9`。运行结束后与 worktree 逐文件比对 **drift=[]**，包含 `native_tasks.go` 主动任务配额、recipient device overflow 隔离，以及 `native_snapshots.go` / `ai_run_commands.go` 两处 metadata SELECT 的最小修复。最终验收脚本 SHA-256 为 `3a9b2fd52de7d15ffd26d27af01be7e80b2171352a6aa12c16c9b72bb4e160eb`。

## 最终 21 项判据

| 场景 | 实际验证 |
| --- | --- |
| 偏好契约与授权 | GET 默认 true/null/UTC；非法 timezone、Local、HH:mm、相同起止时间 400；未认证 401、无宝宝资格 403；无非法偏好落库 |
| REST feeding 创建与重放 | HTTP 201，receipt 重放返回原 record；只有一个家庭事件、收件箱通知、UserChange、device delivery；真实加密请求 201 |
| REST care 路径 | feeding update/delete 分别新版本事件；sleep、diaper create 均实际产生独立事件并发送 |
| common publishRecordChange 路径 | REST supplement；真实 sync growth create/update/delete/restore；sync 重放不重复事件 |
| 冲突与校验回滚 | 改写同 key 请求、错误 baseVersion 返回 409；无效 record 400；record/timeline/cursor/receipt/outbox 均不变 |
| 失败事务回滚 | 在 owned PG 对真实 task_outbox INSERT 安装 test_ trigger 抛异常；care 与 common HTTP 500 均完整回滚；移除 trigger 后同 key 201 且只发一次 |
| worker 并发与重放 | 两个实际 worker 同时处理；只有一个通知与请求，delivery fence=1/attempt=1；完成后重复 worker 不再发送 |
| fanout 前关闭偏好 | 当前 global family_record=false，既无 recipient notification/UserChange，也无 delivery 或 provider 请求 |
| baby 覆盖与发送前偏好 | baby=true 覆盖 global=false；fanout 后 baby=false，child 成功终态 delivered=false / preferences_disabled，provider 请求 0 |
| 发送前宝宝撤权 | fanout 后真实 DELETE 宝宝成员，受保护 GET 403；child scope_revoked，provider 请求 0 |
| provider 503 重试 | 实际 HTTP 503 → queued/attempt=2/active backoff；到期真实 HTTP 201，通知 topic 恒定 |
| provider 403 | 实际 HTTP 403，child failed / 非 retryable / closed，保留有效 device |
| provider 410 | 实际 HTTP 410，delivered=false / subscriptionGone=true，确认失效 device 删除；真实 HTTP 重新绑定后可发送 |
| 遗留无效家庭时区 | 实际 legacy API 保存 test_Invalid/Zone；新照护者无偏好 row 时默认 UTC/null，真实 fanout/provider 201 |
| fanout 时跨日免打扰 | 真实时钟与 IANA Etc/GMT+2，22:00→07:00；child due 为窗末，queued/attempt=0/fence=0，无 provider 请求 |
| fanout 后新设免打扰 | child 第一次 claim 后恢复 queued/attempt=1，延期至窗末；重复 worker 不增加 attempt，不发送 |
| 免打扰不阻塞另一接收者 | 真实 HTTP 给第二人宝宝资格；quiet child queued/attempt=0，另一 nonquiet child 实际 provider 201；第二人获资格前请求为 0 |
| actor 离开家庭 | 真实 HTTP 转移 family/baby admin；record 201 后 actor 自己退出家庭，家庭读取 404、care 403、active membership 0；family-owned head 仍成功，其他照护者收到 provider 201 |
| recipient device overflow 隔离 | 真实 HTTP 保存 65 个 device，按 userId 排在另一 eligible recipient 之前；首人保留站内 Notification 与唯一 UserChange，无 delivery 子任务和请求；head 明确 NOTIFICATION_DEVICE_LIMIT/deviceLimit=64/devicesObservedAtLeast=65/delivered=false；后人真实 provider 201 |
| snapshot manifest API 回归 | 公开契约 POST 202、owner GET queued 200；同家庭另一 principal GET 404；实际 worker 后 owner GET ready 200、另一 principal 仍 404；真实 PG 持久化 12 页，与公开 manifest pageCount 一致 |
| AI 既有 409 兼容回归 | 实际 create 202、空附件同 clientMessageId replay 409，与原始 HEAD 一致，未退化成 metadata 500；message/run/outbox 各仅 1，任务 attempt/fence=0，没有运行 AI worker；202 replay **未验证通过** |

所有推送均由实际 webpush-go 加密。fixture 使用本轮生成的临时 receiver 私钥按 Web Push 算法实际解密 4096 字节 AES128GCM 请求，检查通用 title/body、稳定 tag/eventKey 和 `/notifications` 路由。只保存布尔检查及公开事件 metadata；不保留私钥、订阅 auth、JWT、密码、订阅 token、密文或记录正文。记录 notes/剂量等私密内容未进入保留事件或推送正文。

双 worker 场景证明真实 PostgreSQL lease 竞争与任务重放不重复；撤权场景证明排队后、发送前的当前权限再次校验。它们不声称覆盖“发送检查已经完成后，外部 HTTP 请求途中撤权”的时序，也不声称模拟过失效 lease/fence。跨日延期验证实际 next_dispatch_at 与当前窗口；未把测试时钟推进到结束时间，DST 边界由实施者的独立 Go 单元证据覆盖。

冻结契约没有 `/api/v1/tasks/{id}` 或 snapshot page GET 路由；getNativeTask/getNativeSnapshotPage/read/cancel helper 当前没有公开 HTTP 注册。本报告只声称实际 manifest API 可达，页数由真实 PG 验证，不把 dormant helper 或未定义路径称为 HTTP 验收。两个 metadata 读取字段的内部 Go/PG 定向验证由独立 reviewer 另报。

## 隔离、复跑与清理

复用 iOS 已验证的 `scripts/test-cloud-parity.py` 的 `OwnedRun`，运行时覆盖 `SERVER_ROOT` 为本树的冻结副本。helper SHA-256：`95bbc8eb39a15f739d342d586fc0d91e3f9d64965eb48cd8cab4a9098836a510`。每轮全新 PostgreSQL 18/Redis 8，`127.0.0.1` 独占端口，runtime role 为 `test_app_<runId>`，数据库 `test_growdesk_<runId>`，实际 SQL 确认 `rolsuper=false`。只 bootstrap 使用该新集群的 test_ admin；实际 API、worker、查询与故障 trigger 使用非 superuser role。

注册的 4 个用户、显式创建的家庭与宝宝均 test_ 前缀；不查找真实用户或宝宝。清洁环境仅保留基础运行路径配置，GOPROXY=off、工具链固定为本机 Go 1.27.0；临时 JWT/session/invite/Redis/PG/VAPID 密钥均本轮生成，没有读取任何生产 env。没有启动 MinIO，没有访问旧 Web 3088/prod.db/dev.db，没有启动 Web dev。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/review/check-family-push.py \
  --server-root /private/tmp/growdesk-family-push-20261005 \
  --ios-root /Users/wangzhuo/Documents/GitHub/growdesk-ios \
  --phase baseline
# 原始 HEAD 存在缺口，预期退出 1；不能把这个失败吞成通过。

PYTHONDONTWRITEBYTECODE=1 python3 scripts/review/check-family-push.py \
  --server-root /private/tmp/growdesk-family-push-20261005 \
  --ios-root /Users/wangzhuo/Documents/GitHub/growdesk-ios \
  --phase fixed
# 21 项本卡判据，预期退出 0；不表示既有 AI 202 replay 正常。

PYTHONDONTWRITEBYTECODE=1 python3 scripts/review/check-family-push.py \
  --server-root /private/tmp/growdesk-family-push-20261005 \
  --ios-root /Users/wangzhuo/Documents/GitHub/growdesk-ios \
  --phase baseline --probe ai-empty-replay
# 原始 HEAD 空附件重放已有 409，期待 202 的独立探针预期退出 1。
```

`--server-root` 强制指向脚本所在的独立 managed worktree；拒绝原始 dirty checkout。每个 worker 以本轮拥有的 Popen `--once` 同步等待并显式管理进程组，finally 逐一终止/等待；不依赖 OwnedRun 的 api/minio/redis 清理列表去处理 worker。HTTP fixture 同样显式关闭。

[最终清理报告](backend-e8c705a15195/backend-cleanup.json)：`status=cleaned`、`errors=[]`、`privateDirectoryRemoved=true`、63 worker 全部退出、`stopErrors=[]`、fixture stopped=true。PG/Redis/API 本轮进程已停，整个 owned cluster 与私密运行目录删除，测试租户及未运行的 AI queued job 随隔离集群删除。原始 baseline 和中间失败也都已清理。首次 baseline 的 borrowed cleanup 文案含原 iOS taskId 与未启动 MinIO 的固定资源列表；最终原码复核和 green 已由本脚本改为本任务及实际资源列表，未改写原始失败证据。[最终源与端口检查](FINAL_VERIFICATION.json) 另核对源码、脚本、依赖 SHA 与所有已记录 owned 端口无监听。

未提交、未推送、未部署。下一状态由独立 review 决定。
