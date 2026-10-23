# 网页推送部署记录

2026-10-06：已部署到 https://baby.zwang.fun。网页、Go API、家庭通知专用 worker 均为 active/running；公网入口、实际发布的页面 JS 文件与冻结产物一致。没有发送生产测试推送，也没有访问真实家庭数据进行功能测试。

实现状态保留 IMPLEMENTED_NOT_REVIEWED；本文的部署与运行检查不构成全产品 ACCEPTED 或用户设备收到系统通知的证明。限定订阅恢复、worker profile 和迁移/回滚代码已有独立审查，发现的两处回滚问题已修复并复核。

## 用户订阅恢复

- 沿用原 VAPID 公钥、私钥和 subject。公钥摘要 `76792afefa401d2a6f0d8ddcc126ef9b14e05129e04f89b2cb8c726c6d5ffe61`，现有公私钥配对校验通过；没有生成或轮换生产密钥。
- 原有完整订阅继续使用。浏览器仍保留现有订阅且权限有效时，下次打开、聚焦或刷新网页会自动补回 endpoint、p256dh 和 auth；先完成登录身份初始化，再两次核对服务端当前会话。
- 自动路径不请求通知权限，不新建、退订或更换浏览器订阅。身份不一致、密钥不一致或本地订阅缺失时静默跳过；浏览器已清除/撤销/确实失效的订阅仍可能需要用户重新开启。
- 测试推送不再把完整订阅覆盖成仅有地址的 token；返回实际配置或网关错误，不伪报投递成功。

## 发布来源与保留项

| 产物 | 冻结来源 |
| --- | --- |
| Web | `5c8156d464d0c6e8fd005d46fc9b6f097069da7b`，基于线上 `7a781995e3aee62e82fe45dd0db691a7e6be622f` |
| API / worker | `65ccdaac9fb12b749795e7fcbbcd856a02830600`，Linux arm64、CGO=0 |
| API 二进制 SHA256 | `3068befb3594b38bbd851c5737877f9db407905c7294905b1a1d12c68a59f63b` |
| worker 二进制 SHA256 | `499253bf1acb7fab7895bee54c804a3052abd7a39b1227da5dae84fe9a5334d3` |

原 Web 的 Passport/仪表盘代码及 Next 16.3.6 安全修复已保留。Go 候选保留现有线上语音/ASR/Passport 源码；151 个非本次修改的生产源码输入与旧二进制来源记录完全一致。共享 ASR 文件只叠加推送修改。较大的 server diff 包含此前已部署但尚未入 Git 的语音源码快照，不能把它们全部解释为本次新增功能。

API 和 worker 从原 Web 环境取得原 VAPID，再加载原 Go 环境；启动 wrapper 删除仅属于 Web 的其他变量，因此原 Go 语音/AI 配置不被 Web 默认配置覆盖。`os.execve` 后 MainPID 对应实际 Go 二进制。两份原环境文件的大小、mtime、mode、uid/gid 均保持一致；没有复制到本机、打印秘密或修改其内容。

原 Web `data/archive`、`public/uploads`、`backups`、`llm-profiles.json` 在停服期间复制到新 standalone 目录并逐项验证摘要。原 Web 和服务端本地未提交工作分别保留 7、53 个文件原样；两个共享 ASR 文件此前的最小合入与 inverse-patch 保留证明继续有效。原本地 main HEAD 未改变，也未推送 GitHub。

## 验证

- 63/63 Web 推送/通知回归；TypeScript 检查；本地及远端 webpack 生产构建均 exit 0。
- 最终发布候选全量 Go 测试 exit 0。
- 最终真实隔离 PG/Redis/API/worker 验证 23/23：68 次实际 worker 执行、25 次加密 loopback Web Push 请求，实际解密验证通用通知内容。包含事务回滚、幂等、权限撤销、偏好/静默时间、并发、过期订阅和两种 notifications-only 模式。
- 198 个冻结源码输入 SHA256 总摘要 `d931e5486f93e6fb15febba9e30cf5ba58dc1fae7209a59f7085e98ae21290aa`，无漂移；资源清理完成。见 [最终运行报告](family-runtime-final/persistence-report.json)。
- 本次候选包含线上已有的 AI 空附件重放修复，因此显式要求严格 202 同 ID、同完整 DTO、仅一条 message/run/outbox、改正文 409，且无 AI worker 或外部请求。旧任务树 409 预期在发布候选首次运行失败的记录保留，未冒充通过。
- 受控迁移流程在另一个 owned PG 上验证成功及强制失败全部回滚：角色/表所有权/授权均收口，应用角色始终非 superuser。没有生产测试记录或真实推送。
- 线上 API、Web、worker 的新 PID 分别为 905397、905411、905627，NRestarts 均为 0。API/worker 实际进程二进制 SHA 与冻结产物一致。
- 公网 `/notifications`、`/family/passport`、`/sw.js` 为 200；未登录 push key 和 Passport device API 为 401；公网 Go readiness 的 PG/Redis 均 ok。公网 layout/notifications JS 摘要与已部署文件逐一相同。

## 迁移、worker 与回滚

仅应用新增 `0004_family_notifications.sql`。原 0001–0003 校验值一致，家庭通知部分唯一索引冲突为 0。迁移在同一事务内使用 `pg_advisory_xact_lock(9836172001)`、5 秒锁等待与 45 秒语句上限；DDL 和 ledger 写入由临时 NOLOGIN/NOSUPERUSER/NOINHERIT 受控角色执行。随后恢复原表所有权，只对新偏好表授应用 CRUD，并撤销/删除临时角色。生产执行保留 `ON_ERROR_STOP=1`，提交后校验 ledger、索引、所有权、非 superuser 与 CRUD 均通过。

独立 `growdesk-notifications-worker.service` 已 enabled，命令携带 `--notifications-only`；只领取家庭记录通知及带相应标记的推送 child，不启动通用 worker 或 scheduler。上线前主机未有 Go worker/scheduler。旧的其他任务不因本次部署被执行。定时每日总结/疫苗等提醒 producer 不属于这张部署卡。

受保护的数据库备份保存在服务器发布目录，mode 600，约 1.9 MB。`pg_restore --list` exit 0 只证明归档目录可读，**未进行生产备份恢复测试**，也未把真实家庭资料恢复到隔离测试库。

服务器发布目录：`/home/ubuntu/growdesk/push-releases/web-push-20261006`。旧 `.next` 与 API 保留在其 `rollback/`，数据库变化为新增 schema/index/table。需要回滚应用时，先停止并禁用通知 worker，核对其 inactive 且 MainPID=0；再停 Web/API、恢复旧 `.next` 与旧 API、删除本次 `40-web-push.conf` 和通知 worker unit、daemon-reload 并启动旧服务。保留新增数据库结构及新数据，不删除表或回灌旧备份覆盖新写入。完整实际激活/失败回滚实现见 [activate.py](operations/activate.py)。迁移阶段失败不会停启仍健康的旧服务；worker 停止失败不会伪报回滚成功。

尚未证明用户设备实际弹出系统通知；没有使用真实家庭写测试数据，也没有发送生产测试推送。部署已核验不替代 APNs/FCM/WNS 或物理设备最终收件。

证据：[发布回执](remote/deployment-receipt.json)、[公网验证](public-verification.json)、[运行与静态资源核对](runtime-public-final-verification.json)、[迁移隔离验证](migration-preflight.json)、[Web diff](web-source.diff)、[服务端 diff](server-source.diff)。
