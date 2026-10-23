# PUSH_COPY_READABLE_20261007 — 独立审查

审查状态：**REVIEWED_NO_BLOCKING_FINDINGS**（不代表部署或用户验收）。本审查限于冻结的通知 formatter/helper/tests，以及 API/worker activation 脚本的静态检查和本地控制流模拟。

## 范围与结果

- 辅食文案现能显示 `little/half/most/all` 的中文份量、喜欢程度 `n/5`、开心/一般/拒绝、无异常/有异常与异常备注。已知 v1 观察包按类型和值域解码；坏包、未知版本和内部标签不会原样出现在正文。普通 JSON 备注与多行文本保留。
- 食材名称按当前家庭或全局目录解析；混合目录项、旧名称和 opaque IDs 保持顺序，未解析的 `food_*`/UUID/自定义 ID 用中文占位显示。补剂 `productId` 标签不泄露内部 ID，正常备注保留。
- 时间使用通知快照里的家庭本地时间；不显示 IANA/offset。同日不重复日期，异日保留记录日期。内容仍使用 snapshot v1，未更改记录/notes 存储、schema、订阅、VAPID 或推送 payload 结构。
- 未发现最终冻结 formatter/helper/tests 中的可复现阻断。审查中发现的三项内容损失（无法解析的异常备注、空 productId 标签吞掉后缀备注、未知 `food_*` ID 外泄）均在最终冻结版本中修复并有测试覆盖。

## 验证证据

- 独立运行聚焦 Go 测试：`go test ./internal/backend -run 'Test(RenderFamilyNotification|LegacyFamilyNotification|FamilyNotification|FamilyPushPayload)' -count=1`，通过。
- 独立运行 `git diff --check`，通过。根代理另记录完整 `go test ./...` 退出码 0，详见 `go-all-tests.json`。
- 旧行为红证据：`backend-7aa7649acdc8/persistence-report.json` 重现真实隔离 HTTP 写入、worker 投递和解密后的原始 capsule/`most`/ID 文案；baseline 预期失败，cleanup errors 为空。
- 最新完整隔离运行：`backend-e747395bae56/persistence-report.json` **27/27** 通过、312 HTTP assertions。新增截图路径包含 6 次真实 HTTP 写入，每条通过 notifications-only worker 与加密 loopback Web Push 解密验证；最终 fixture 共收到并解密 **59** 条加密 Web Push，Inbox 与推送正文相同，AI 202 任务保持 queued/unclaimed。source hash 前后相同、`drift=[]`，136 个 worker 均退出；`backend-cleanup.json` 显示 PostgreSQL、Redis、API、workers 和 loopback fixture 清理完成且 `errors=[]`。此前失败的完整运行保留在 `backend-dcb7e6c723de` 与 `backend-c2a0ca562a4d`。失败运行中可见新事件被创建时 `queued attempt=0`，且其 `next_dispatch_at` 略晚于创建时间；这只能说明该次观察时通知尚未被 worker claim，不能单独证明失败的确定原因。最终通过的验证使用 notifications-only worker profile，并显式断言 AI 202 任务仍 queued/unclaimed；没有加入 due-time 等待修正。

## 冻结源码指纹

| 文件 | SHA-256 |
|---|---|
| `internal/backend/family_notification_content.go` | `5827e4dd05cef86c106ac6264dd1d4d6a2b443ca0bf6fa20d07e72cc923de32c` |
| `internal/backend/family_notification_content_test.go` | `bca77ba27917e0f5be438a04afb027556c60bf11ec02a3e52f73af65a0c321b5` |

## API/worker activation 脚本审查

静态检查确认脚本核对 baseline API/worker SHA-256 与 revision `8b9edd3be223c2e784bf3ba617d7f11eac27323a`；只替换 API binary 并安装 worker systemd drop-in，启动 `--notifications-only` worker；前后核对 Web PID/restart 状态、Web build provenance、现有 drop-ins/environment launchers/strip metadata hashes，以及 `.env` 和 API env 文件元数据。失败分支恢复 baseline API、移除新增 drop-in 并恢复旧 worker。没有 DDL、VAPID/订阅更改、合成推送或读取 env secret 值的操作。

review 时发现的 preflight backup 目录重试问题已修复：只有本次创建且尚未开始切换时才清理目录，并已加入 strip metadata/API launcher SHA guards。冻结脚本 SHA-256：`activate.py` `0ed88270100f025591a7c77c24d84f4676bf8d546125a575f801ce941df1ae3d`；`environment-launch.py` `5e662d0308d44d1b7a39a44ddd5a312661c271c5112454de4e7e0458eb5348d3`。五种本地控制流模拟均通过：成功切换、API readiness 失败回滚、worker 启动失败回滚、备份复制失败时清理、预先存在的备份目录保持不变；详见 `operations/activation-control-flow-tests.json`。另外，`operations/candidate-build.json` 记录了 revision `ba7abcfb0ffe7253b8bff9322c15ab620a5743a8` 的 clean archive candidate；200 个归档输入与 green 输入比较，archive SHA-256 为 `bc5ace982786325453f53dfc3c998577c9b24aa393384558bc96a2b643ad6e5c`，其中 API/worker/launcher 指纹与报告记录一致。这些是静态检查、本地模拟和候选构建证据，不证明远端部署或真实系统通知送达；本审查没有执行 activation 或访问生产环境。

实现状态仍为 **IMPLEMENTED_NOT_REVIEWED**，生产部署和物理设备送达不在本审查结论内。
