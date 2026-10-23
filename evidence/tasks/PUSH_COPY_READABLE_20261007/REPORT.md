# PUSH_COPY_READABLE_20261007

修复已部署。部署源码提交：`ba7abcfb0ffe7253b8bff9322c15ab620a5743a8`，专用分支 `codex/push-copy-fix-20261007`。实施者报告为 IMPLEMENTED_NOT_REVIEWED；之后完成独立审查，结论为 REVIEWED_NO_BLOCKING_FINDINGS。生产切换和上线检查另有实际收据；尚未验证用户手机上收到修正后新通知的画面。

## 原因与改动

用户截图中的辅食观察信息被旧 Web 编码在备注里，前次完整内容 renderer 直接显示存储值，因此暴露 `[growdesk-web-food:v1]` JSON、`most`、误标的食物项 ID、IANA 时区/offset 和重复日期。实际根因在文案生成，而不是本次订阅加密信息。

- 只解码识别到的 v1 辅食观察包，逐字段检查类型和值域，显示中文份量、喜欢程度 n/5、进食状态、异常情况和有效异常备注。某字段坏值不会丢掉同包里的有效备注和观察内容；未知版本或坏包显示说明，保留原始记录数据供打开查看。
- 普通未标记 JSON 备注、多行文本、合法零值保持原有内容；已明确无异常时不显示历史残留异常说明。
- 食物逐项按当前家庭/全局目录解析名称，保留旧版食物名称和混合顺序；无法解析的内部 ID 显示中文占位，不静默丢掉条目。补剂 legacy productId 标签安全解开，保留正常备注；产品查找仍检查当前家庭。
- 日期时间使用家庭当地时间，隐藏为零的秒、offset 和时区名称；非零秒/毫秒仍保留。同日记录日期去重，异日日期保留。

未改 schema、原记录/notes 存储、快照 v1、权限/静默时段/幂等/重试/fence 行为或 Web Push 字节预算。旧快照不回写；已经送达的旧系统通知不会自动替换。修复应用于部署后新创建的通知快照。

截图相同有效字段现在会渲染为：

> 发生时间：2026-10-07 11:35；餐次：午餐；食物：10倍小米粥 + 牛肉泥 + 菠菜泥 + 蛋黄；份量：大部分；喜欢程度：5/5；进食状态：开心；异常情况：无异常

此处是格式示例，未向真实家庭写入或发送该示例。

## 验证

| 层次 | 证据与结果 |
|---|---|
| 故障重现 | [同脚本真实 RED](backend-7aa7649acdc8/persistence-report.json)：6c2ca25 Git archive，独立 test_ 家庭、真实 HTTP/PG/worker、AES-GCM loopback 推送解密，原始 JSON/most/ID/重复日期实际可见，按预期失败 |
| 内容回归 | [实施报告](CONTENT_REPORT.md)：10 个聚焦 Go 测试通过；独立 reviewer 另跑聚焦测试和 diff check |
| 全部 Go | [全部 Go 测试](go-all-tests.json)：`go test ./...` 退出码 0，最终两 Go 文件 SHA 与部署来源一致 |
| 完整隔离运行 | [最终 GREEN](backend-e747395bae56/persistence-report.json)：27/27，312 HTTP assertions，136 actual worker runs，59 个加密并解密的自有 loopback Web Push；新增 case 含 6 次真实 HTTP 写入、通知 worker、HTTP/DB inbox 和 wire 一致 |
| 安全边界与清理 | source drift=[]；AI replay=202 保持 queued/attempt0/fence0；全部 test_ 隔离 PostgreSQL/Redis/API/worker/fixture [清理成功](backend-e747395bae56/backend-cleanup.json)，errors=[]；未使用生产数据库做测试或真实外部推送网关 |
| 独立审查 | [REVIEW.md](REVIEW.md)：无可复现阻断；发现的有效字段丢失已修复；API/worker-only 部署脚本及回滚路径静态审查通过 |
| 部署控制流 | [本地模拟](operations/activation-control-flow-tests.json)：5/5，包括成功、API readiness 失败回滚、worker start 失败回滚、备份失败可重试、已有备份不会删除；模拟与真实上线证据分开 |

RED/GREEN runner SHA-256 都为 `75a495f8ae706448670ed45b5505185a9afb197ee42e65a67945a0d07575d72c`。最终 runtime 使用 HEAD=6c2ca25 加被冻结改动；之后提交为 ba7abcf，从该提交干净 Git archive 构建候选，并对照 GREEN 的 200 个产品输入逐文件哈希。[候选构建证明](operations/candidate-build.json) 已记录。

中间失败的 `backend-dcb7e6c723de`（迭代期间源码变化）和 `backend-c2a0ca562a4d`（新增通知用例未被 generic one-shot worker 领取）保留，不计为通过。最终新用例使用实际生产的 notifications-only profile，同时验证先前 AI 排队任务未被领取；没有吞掉测试失败或跳过原 26 项。

## 部署与读回

只切换 Go API 和通知 worker。Web 仍为已有 `5fa673c23c8886a097477e01cf200d5279f98348`，PID 1956540 保持不变，未覆盖另一次网页部署。

- API 运行进程 PID 1752897，SHA-256 `f0bf9f85bc7e347a2aca6024bbbc846bdbe9d43c5cb710e9092e2a466c802462`。
- 通知 worker PID 1753061，SHA-256 `76fb27fc9fdff3ef34359c94759e4d671e0736e42f652d0f721e934a40563c25`，`--notifications-only`。
- 两进程 revision 都是 ba7abcf，active/running、NRestarts=0；实际 `/proc/<pid>/exe` 哈希等于候选。
- `.env`、api.env 文件元数据前后完全相同；原 API launcher、worker launcher、已有 drop-ins 和变量名过滤元数据哈希都被守卫。没有读取 secret 值、重置订阅、轮换 VAPID、执行 DDL 或发合成生产推送。
- 公开 API readiness 为 200，PostgreSQL/Redis 都 ok；未认证 notifications API 为 401。网页 notifications/sw.js 为 200，未认证 vapid-key 为 401。

实际证据：[部署收据](operations/deployment-receipt.json)、[上线读回](operations/readback-receipt.json)、[上传收据](operations/upload-receipt.json)。远端不可变 release 为 `/home/ubuntu/growdesk/push-releases/readable-notification-copy-20261007`，保留当前前版 API 备份与既有 worker drop-in 作为回滚基础。

## 原工作区与交付

[delivery.diff](delivery.diff) 只含 renderer、对应单测和实际隔离 runner 三个文件。原工作区 HEAD 保持 516371a，开始时 73 个 dirty source files 中只更新这三个所属路径，其余 70 个逐文件哈希保持一致，没有丢失用户改动：[保留证明](original-preservation.json)。

原工作区已整合以上三个文件和本任务证据，未重置、合并或暂存其他文件。生产实际新通知的手机显示仍需自然产生的下一条记录确认；本文不把 loopback 解密或健康检查当作手机系统通知回执。
