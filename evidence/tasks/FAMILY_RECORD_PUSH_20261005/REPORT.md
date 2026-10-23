# FAMILY_RECORD_PUSH_20261005

状态：**IMPLEMENTED_NOT_REVIEWED**。本卡实现和隔离回归已完成；本报告不代表已部署或设备收到系统通知。

工作树：`/private/tmp/growdesk-family-push-20261005`，基线 `516371a5959e11db865969cd0b2f9aa42be9bfa2`。仅修改本卡明确允许的代码、契约、迁移和证据；保留用户既有 ASR/Passport/TTS WIP。`native_processors.go` 与 `ai_run_commands.go` 是共享文件，本卡各自仅追加最小分发/兼容 patch；整合时不能用本树整文件覆盖原 WIP。未提交、推送或部署；原目录 SHA/共享文件逆 patch 保全证明由独立整合报告提供。

## 已验证的原始缺口

独立 runner 对 HEAD 做 `git archive` 冻结，再启动专属 PostgreSQL/Redis/Go API/native worker。真实注册 `test_` 用户、创建测试家庭/宝宝、授权另一用户的 baby membership、保存完整 WebPush subscription 后，REST feeding 返回 201，记录和 FamilyChange 各增加 1，但家庭通知任务、投递任务和 Notification 都增加 0；worker `--once` 没有网关请求。

证据：`backend-84ff7262f462/persistence-report.json`。该报告 `passed:false` 是预期的 red baseline（expected family task=1，actual=0），不是跳过失败检查。

源码对应两个事务接缝：`care.go:647` 的 REST feeding/sleep/diaper 与 `record_mutation.go:188` 的公共记录命令。原生真实 WebPush sender 原已存在；缺的是已提交记录到通知任务的事件生产。

## 实现与权限边界

- 在上述两个记录事务内写稳定 `family_record_notification` TaskExecution 和 task_outbox。允许类型为 feeding/sleep/diaper/food/supplement/growth，操作为 create/update/delete/restore。FamilyChange、记录、timeline、receipt、event task/outbox 同一事务提交；重放返回已有 receipt，不再次 enqueue。clinical 事务、定时日报和疫苗 scheduler 未扩展。
- 事件身份由 family/baby/entity type/entity ID/version/operation 生成。head task 属于 `family:<familyId>`，不绑定 actor 后续账户或 membership；普通任务仍要求原有 user owner 校验。decode 同时验证 kind、type、payloadVersion、owner scope 和家庭事件 metadata，不能混搭普通任务以放宽权限。
- fanout 先按稳定 user ID 分批查当前显式 active baby_members 与 family_members，再为每位接收者开新事务：UserSyncState → FamilySyncState → TaskExecution → Notification/device/task。锁后重查 user/family/baby、两级 membership、当前偏好，排除 actor。既有记录/Family 事务接缝只追加 family outbox，不回头获取接收者 User 锁。
- 每位接收者的 Notification、UserChange 和按事件/设备去重的 push_delivery 同事务提交。已存在 Notification 时不重复 UserChange 或 child task。worker 进度随接收者事务提交，重放仍使用稳定身份。Notification/UserChange 公共 DTO 不含 token 或凭证。
- delivery 在发送前再次获取 User→Family→Task 并重查当前 scope、偏好、quiet window；撤权或禁用记录 `delivered:false` 和明确 skippedReason，quiet 将该设备任务重新排队并把 next_dispatch_at 移到窗口结束，不进入失败重试、不额外消耗 attempt，也不阻塞其他 recipient 的 fanout。沿用现有 lease、fence、SKIP LOCKED、heartbeat、retry 和 410 token 比较删除机制。
- 接收者分页 32，总接收者上限 1024，单用户设备上限 64，均有稳定排序和显式错误；没有无序 LIMIT 静默漏发。某接收者设备超限时保留站内 Notification/UserChange，对该人不创建任何设备投递（不会静默只发前 64）；head progress 与最终 result_ref 持久记录 recipientErrors[userId]（code、deviceLimit、devicesObservedAtLeast、notificationId、delivered:false），继续其他接收者。head succeeded/fanoutComplete 只表示扇出处理完成，recipientErrorCount 与错误 map 明确表示局部失败，不宣称所有设备成功。被动 push_delivery 不计入六类主动提交任务的 64 条配额，主动配额的 user advisory lock 仍保留。
- migration 0004 只对 `family_record:` namespace 增加 recipient/event 部分唯一索引，对家庭 outbox 增加 task/phase 部分唯一索引；没有给原有常量 AI event key 添加全局唯一约束。

主要代码：`family_notifications.go:95` enqueue；`:146` fanout；`:206` recipient transaction；`:269` Notification/UserChange/device task；`:312` delivery permission/preference check。`native_processors.go` 仅新增 9 行 kind 分发，不改 AI 完成通知或 ASR 实现。

穷尽所有 decoder 业务调用者：claim 原本提供 outbox metadata；`native_snapshots.go` 的 owned task 读取与 `ai_run_commands.go` 的相同 clientMessageId 重放，各自只在既有 SELECT 补上 o.type/o.payload_version 两字段。保留严格 kind/type/version/owner 验证，不以接受缺失字段绕过兼容问题。getNativeTask/cancelNativeTask 是未注册的内部 helper，契约没有 `/tasks` 路由；不能把 Go+PG 方法检查报告为该 HTTP API 已验收。本卡不为测试新增该路由。

源码清单共 12 个 tracked 文件：`internal/backend/{ai_run_commands,care,foundation_test,native_processors,native_push,native_snapshots,native_tasks,notifications,record_mutation}.go`，`packages/contracts/src/{devices,routes}.ts`，`contracts/openapi.json`。4 个新主文件：`internal/backend/family_notifications.go`、`family_notifications_preferences.go`、`family_notifications_test.go` 与 `native/migrations/0004_family_notifications.sql`。独立 runner 只写 `scripts/review/check-family-push.py` 与本卡证据；未将其源码写权扩大到业务代码。

## 新增兼容偏好契约

`GET /api/v1/me/notification-preferences[?babyId=<UUID>]`：operationId `getNotificationPreferences`。

`PUT /api/v1/me/notification-preferences`：operationId `putNotificationPreferences`，示例完整请求：

```json
{
  "babyId": null,
  "timeZone": "Asia/Shanghai",
  "kinds": { "family_record": true },
  "quietHours": { "start": "22:00", "end": "07:00" }
}
```

成功响应为 `{ "data": <相同结构> }`。`babyId` 为 null/未提供时更新当前 principal 的全局默认，UUID 时必须具有该宝宝当前读权限。baby 设置覆盖全局设置。PUT 是完整替换，timeZone、kinds、quietHours 必填；quietHours:null 关闭静默。额外字段由现有严格契约校验拒绝；客户端 user/family ID 不构成授权。偏好更新发布 UserChange，相同 PUT 无额外版本/cursor。

默认沿用旧 Web 对已订阅设备的家庭动态提醒语义：family_record=true、quietHours=null；宝宝默认取 family timezone，全局默认 UTC。旧家庭 API 历史上允许任意 timezone；没有显式偏好且该值无效时回退 UTC，不因没有静默窗口而丢提醒。显式 PUT/存储偏好仍拒绝非法时区。

quiet 开始包含、结束不包含；允许跨午夜；HH:mm 必须补零且有效；相同开始/结束拒绝，避免隐式 24 小时静默。按 IANA 实际时间轴逐分钟寻找结束，DST 春季缺失时刻取首个非静默有效分钟，秋季重复时段按各自实际时刻判断，搜索上限 48 小时。内嵌 `time/tzdata`，worker 不依赖镜像的系统时区库。

实现为 additive `public.notification_preferences` 表和 TypeBox/OpenAPI 契约，不重写历史 Prisma migration。生成契约为 113 paths / 161 operations；基础测试固定总数从 159 更新为 161，并明确断言两个新增 operation 有已注册 Go handler。

## 推送文案与 Web 兼容

家庭推送固定 title `家庭动态`、body `有新的照护记录`、tag 为稳定 Notification UUID、点击 URL `/notifications`。data 仅包含：

```text
eventKind: "family_record"
familyId, babyId, actorId: UUID
entityType: feeding|sleep|diaper|food|supplement|growth
entityId: UUID
operation: create|update|delete|restore
recordVersion: 正十进制字符串
eventKey: "family_record:<64hex>"
url: "/notifications"
```

不包含宝宝名、记录 payload/summary、病历、AI 正文或 subscription/token。Web BFF 可用 entityType/entityId/recordVersion 排除同版本派生条目并保留远程 UUID/已读状态；Web 合并改动由独立 Web 小卡负责。

WebPush endpoint 增加 HTTPS/443 的 `.notify.windows.com` 子域边界，其他 HTTPS 服务 allowlist、DNS/proxy/redirect guard 和 dev/test 仅 owned-loopback 要求保留。这只完成 WNS endpoint 兼容，并未证明 Windows 设备收到。域名边界依据 [Microsoft WNS guidance](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview)。

## 已执行的检查

本地全量 Go 使用缓存离线 Go 1.27，未下载 toolchain 或依赖：

```sh
env GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off \
  /Users/wangzhuo/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go \
  test -mod=readonly ./... -count=1
```

退出 0（最后设备超限隔离与 decoder 两处 SELECT 修正后再次完整执行）。新增六组定向 unit 覆盖稳定身份、task owner/type/version metadata 混搭拒绝、九个 quiet/DST 边界、非法偏好、仅 metadata 文案、WNS HTTPS 域名边界。权限、事务和并发证明来自真实 PG runner，没有用 mock 替代授权/存储。根代理在清洗环境对含用户既有 WIP 的原目录也执行同一完整 Go 测试，退出 0；日志为同目录 `original-integration-go-test.log`。

`npm ci --offline --ignore-scripts --no-audit --no-fund`（虚拟清洗环境安装 worktree 忽略的依赖）、`npm run --workspace=@growdesk/contracts build`、`node scripts/generate-contracts.mjs`、`node scripts/check-contracts.mjs` 均退出 0。实现 Go 文件已 gofmt；foundation 只格式化新增 inventory 函数，保留既有其他测试。`git diff --check` 退出 0。

最终独立真实集成证据：`backend-e8c705a15195/persistence-report.json` **21/21**，233 次真实 HTTP、63 次 native worker `--once`、23 次真实 webpush-go 加密请求到 owned-loopback receiver。receiver 使用标准 Node crypto 实际解密 AES128GCM 并验证通用文案和 metadata 无记录正文，所有请求 decrypted/privacySafe=true。冻结输入 SHA256：`2567c40b34781f84744bc817a6e95738d29d83d117d4ff1f75c7a7c8812715a9`；155 个构建输入逐个比对最终源码，drift=[]。包括设备超限隔离与两个 decoder SELECT 修复。

最终 runner SHA256：`3a9b2fd52de7d15ffd26d27af01be7e80b2171352a6aa12c16c9b72bb4e160eb`。只读借用的 iOS OwnedRun 源码 SHA256：`95bbc8eb39a15f739d342d586fc0d91e3f9d64965eb48cd8cab4a9098836a510`，路径 `/Users/wangzhuo/Documents/GitHub/growdesk-ios/scripts/test-cloud-parity.py`；环境为严格白名单、虚拟 keys、fresh PG/non-superuser test_app/Redis/loopback fixture。

| 验收 | 真实结果 |
| --- | --- |
| fresh test_ 注册/session/family/baby/device/prefs | 真实 HTTP；无权限宝宝 GET/PUT 403、无 session 401、非法输入 400 |
| REST care | feeding create/replay/update/delete，sleep/diaper create，记录与任务提交 |
| common 命令 | supplement REST 与 growth sync create/update/delete/restore/replay |
| receipt/version 冲突 | changed key body/stale version 409，无额外 record/cursor/timeline/receipt/outbox |
| 事务故障 | PG trigger 在 outbox INSERT 抛错，care/common HTTP500 所有持久化回滚；相同 key 重试 201 仅一次 |
| 并发/重放 | 两个实际 worker 竞争 + 重复 --once，Notification/device task/provider request 不重复 |
| 当前偏好 | global disabled 时不创建 receiver artifacts；baby override；fanout 后 disabled 终止，不请求 fixture |
| 撤权 | fanout 后真实 HTTP 撤 baby membership，后续 403，child scope_revoked，0 fixture 请求 |
| provider | 503→201 重试保持 topic；403 terminal failed 保留有效 token；410 删除确认失效 token 后真实 HTTP rebind 可再次投递 |
| 时区 | legacy invalid family timezone 默认 UTC 仍真实投递；cross-midnight quiet child attempt0 延后；late quiet claim 后 attempt1 保持且重复 worker 不消耗 budget |
| 单接收者设备超限 | 首位接收者实际注册 65 个设备，保留 Notification/UserChange + recipientError、0 child/0 provider 请求；后续另一接收者仍真实 201 |
| 既有公开 snapshot API | 真实 POST202、owner manifest GET queued200→实际 worker→ready200、另一个 principal 两次404，PG pageCount12；未将 dormant task/page helper 当成 HTTP API |
| 静默接收者隔离 | 真实授权第二接收者，第一人 quiet queued attempt0、第二人 nonquiet child 实际 201 |
| actor 后续离开 | 真实转移 family/baby admin 后 record201，再 actor 自己 HTTP 退出，后续读记录 403/active membership0；家庭 head 与另一 recipient 仍实际 201 |
| AI 相同消息元数据兼容 | 真实 create202/replay409，与 HEAD 空附件既有行为一致，无新增 metadata500；1 message/run/outbox、0 AI worker，不宣称 replay202 已绿 |

独立审查 PG quota 证据：`review-quota-before.json` 红，`review-quota-after.json` **2/2 绿**。64 个真正 quiet family child 不阻塞具有有效 baby scope 的 snapshot；64 个主动 user_data_export 仍拒绝第 65 次，429 TASK_QUOTA_EXCEEDED。没有 HTTP push，专属 PG 18 / 非 superuser test_app 均已清理。

独立审查 PG 接缝证据：`review-device-overflow-before.json` 红，`review-device-overflow-after-green.json` **1/1 绿**；`review-metadata-read-after-green.json` **2/2 绿**。使用真实 Go 方法、授权与 PG 事务，验证超限用户 inbox/UserChange 保留、head 显式错误且继续下一人；内部 task helper 读取/取消、mixed type/version 拒绝和 AI HEAD 行为一致。该方法级检查没有 HTTP server/worker/provider，也不声称不存在的 /tasks 路由可用。

既有 AI 重放问题单独保留：原 HEAD 冻结的 `backend-a16999690900/persistence-report.json` 真实 HTTP 创建 AI run 202，空附件同 clientMessageId 重放返回 409，未达到契约预期 202，因此该 baseline probe 明确 exit 1 / passed:false。源码原因是 AttachmentIDs 的 omitempty 保留成 nil，重放请求解析为空数组，两者 hash 不同。这不是本卡新增问题，本卡不扩大 AI 修复；两个 SELECT 元字段兼容修应恢复原有路径，而不是宣称无附件重放已通过。该 probe 没有执行 AI worker，没有外部 LLM 请求。

上述绿色整体验证只使用虚拟 VAPID/外部 API keys、专属 PG/Redis/loopback provider；允许的 host/database/role guard 明确校验并拒绝生产/SQLite。生产 secrets、prod.db/dev.db、3088 均未读取或连接。最终 `backend-e8c705a15195/backend-cleanup.json` 表明所有 worker/API/PG/Redis/fixture 退出，private directory removed=true，errors=[]，0 公网推送请求。

## 运行与证明边界

- 上线前需正常迁移权限应用 `native/migrations/0004_family_notifications.sql`，runtime role 具有 Notification/preference/UserChange/task/outbox 读写权限。`growdesk-migrate` 在隔离环境已应用并重放两次，checksum/事务迁移通过；这里没有操作生产迁移。
- API 只运行 HTTP。需要单独 native worker 进程消费 PostgreSQL 队列，并具有同一安全 database/Redis runtime 配置，以及与 Web subscription 对应的 VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT。APNS 设备仍需原有 APNS 配置；本卡不改变其配置或部署。
- 缺 adapter 配置仍创建可观察的 delivery task，执行给出 PUSH_NOT_CONFIGURED，不假报成功；已提交 record 不因后续 provider 失败回滚。HTTP status/result_ref 表示网关响应，不保证设备展示。
- 外部发送保持计划要求的 at-least-once：正常 receipt 重放、worker 竞争和已确认重试有稳定 Notification/tag/topic；网关已接受但进程在 DB 确认前崩溃时，不能承诺 HTTP 绝对一次。发送前权限检查后的在途撤权也不能撤回外部已接受请求。
- food 的 allowlist/common transaction 接缝与完整锁顺序/fence 由源码核查；本报告不把尚未执行的运行场景列为绿。双 worker 竞争通过不等于撤权锁屏障测试；内部 task helper 方法级 PG 检查不等于 HTTP 路由验收；原有无附件 AI replay409 仍未修复。实现 review 与部署由独立阶段决定。
- 没有物理浏览器/手机系统推送显示、Windows WNS/APNS 真机投递、生产 worker/config 或部署状态的证明。定时日报与疫苗通知不属于本卡。

协议依据：计划 02 的原子记录/outbox、User→Family→Task 锁顺序、家庭 outbox 与 receiver 新事务、Notification/UserChange、quiet/权限发送检查与偏好 API；计划 04 家庭动态/隐私要求；计划 06 隔离和实现状态；计划 09 shared Go/native task 验收。当前任务已明确授权普通实现，不以目录约定新增审批流程。

## 交付与原目录整合

[CHANGES.patch](/Users/wangzhuo/Documents/GitHub/growdesk-server/evidence/tasks/FAMILY_RECORD_PUSH_20261005/CHANGES.patch) 包含本卡 17 个实现/契约/测试/验收脚本文件及脱敏证据的独立 diff，不包含用户原有 ASR/Passport/TTS 改动。

[integration-report.json](/Users/wangzhuo/Documents/GitHub/growdesk-server/evidence/tasks/FAMILY_RECORD_PUSH_20261005/integration-report.json) 记录原目录整合后的源码校验值：53 个既有未提交文件保持原始 SHA-256；两个共享文件只应用本卡最小 patch，并以独立临时副本的逆 patch 验证还原到原始 SHA-256。原后端目录完整 Go 测试退出 0。Web 的原目录类型检查仍被保留的既有日报测试错误阻塞，详见 [Web 报告](/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia/evidence/tasks/WEB_PUSH_DELIVERY_20261005/REPORT.md)。未暂存、提交、推送或部署。
