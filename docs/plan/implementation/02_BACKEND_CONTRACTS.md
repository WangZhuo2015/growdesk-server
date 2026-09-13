# 02 — 后端改造与接口、事务执行规格

> **2026-09-11 产品决策更新**：应用正常联网，可选择数据仅本机保存；云同步/协作需主动授权。涉及登录前置、仅缓存、本地保留和“必须联网”的规则以 [07 本地保存与按需云协作](07_LOCAL_FIRST_OPTIONAL_SYNC.md) 为准；云端事务、权限与幂等不变量继续有效。

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


状态：规范性设计；所有 v1 接口/新表/命令尚待实现。以本文件约束具体实现，不能直接把伪代码粘贴后跳过事务与并发测试。数据库字段映射见 03，任务拆分见 06。

## 1. 实现顺序和不可打破的不变量

先完成契约与独立测试环境，再写身份、事务写入口、同步、任务、附件与领域路由。iOS 与 Web/MCP 适配器依赖这些能力，不能各建私有写路径。

必须通过的系统不变量：

1. 权限由已验证 principal 决定；目标 ID 不构成授权。所有缓存键、查询、下载和 task 都有 owner scope。
2. 一个业务写操作中，实体变化、version、snapshot、change feed、幂等凭证、notification/task outbox 要么一起提交，要么一起回滚。
3. 成功响应只发生在 PostgreSQL 提交之后。客户端已显示“本地保存”与“已同步”是不同状态。
4. 再次投递同一个命令不重复生成记录，异内容复用键不能覆盖旧操作。
5. feed cursor 不漏已提交变更，包括删除、MCP/AI 写入和较晚提交的事务。
6. HTTP/SSE 断开不取消服务端 run；Redis 丢失不抹掉 PostgreSQL 中已接受的任务。
7. 删除、权限撤销、设备撤销必须影响后续请求和待执行工具，不只更新界面。
8. 测试只能连接独立 PostgreSQL 测试实例与测试资源，不得接生产或旧真实 SQLite。

## 2. 契约生成与通用 HTTP 规则

### 2.1 单一 schema 源

`packages/contracts/src` 保存 TypeBox schema。route 用同一个 schema 做请求验证/响应序列化；启动用于文档导出的 Fastify 实例（不监听公网、不连生产）注册 routes，经 swagger 导出 `contracts/openapi.json`，固定 `openapi: 3.0.3`、稳定 operationId。

只使用已经在 BOOT-01 验证可完整导出的 schema 子集：object、array、primitive、string enum、显式 discriminator 联合、nullable、日期/UUID/decimal string。不要直接把 DB Date/Decimal/BigInt 输出；显式 DTO mapper。禁止任意运行期扩展由模型提供的 schema。

生成 Swift 客户端并编译，执行一组必备样例：null 与 absent、不认识的枚举、oneOf/discriminator、multipart、分页、409、decimal、大游标、SSE文档。若插件对 nullable/union 的导出有损，编写一个有测试的集中导出转换器或收敛 schema 写法，不能手改生成 JSON。

CI 必須保证生成结果无 diff、operationId 不重名、全部成功/失败响应符合契约；非兼容变更报错。文件生成不代表 endpoint 已实现：`x-implementation-status`/任务矩阵标记以实现清单为准。

写入body默认`additionalProperties:false`，Ajv配置不得默默removeAdditional或把字符串强制转换为数值/布尔；query参数转换由显式schema适配器处理。未知客户端可写字段返回400，不能“删掉字段后成功”掩盖旧客户端不兼容。event timestamp/date、entityId在写入协议中必填，不用每次重试的服务器now自动补业务时间；纯默认值必须确定，canonical请求hash在此后计算。createdAt/updatedAt/actorId/version由服务器维护，不接受客户端覆盖。

### 2.2 通用规范

- URL 前缀 `/api/v1`，HTTPS；业务API使用 Bearer；Web adapter自行管理cookie/CSRF。
- 常规JSON body上限256KiB；批量命令最多50项、总量1MiB；图片/音频走附件协议。字段maxLength与数值上下限必须继承并明确现有规则，不能全部 `any`。
- 事件时间：RFC3339含时区，服务器归一到UTC毫秒；日历日期：`YYYY-MM-DD`；时区独立IANA字符串。拒绝无时区时间，不猜服务器本地时区。
- 旧ID原样保留，新实体由UUIDv4产生；移动端允许预分配业务record ID。绝不通过新建ID重新导入现有外键图。
- version/cursor/数据库bigint在HTTP中用十进制字符串，避免JS/Swift转换精度问题；测量/营养Decimal用十进制字符串，单位由字段名和schema固定。
- 列表默认50、最大200，keyset游标包含排序键+ID，禁止无限limit和面向大表的offset翻页。
- 成功单对象 `{data: ...}`，列表 `{data: [...], page: {nextCursor: string|null}}`；同步/AI使用下述专门envelope。
- 所有错误 `{error:{code,message,details?,requestId}}`。message供人读、code供程序决策，details禁止SQL/内部路径/secret。
- 400格式错误；401会话无效；403当前用户无权执行某项动作；跨租户资源查询通常404避免枚举；409版本/状态/幂等冲突；410游标/快照过期；422领域输入错误；429配额；503依赖不可用。响应不返回200伪成功。
- `X-Request-ID`服务器生成或验证传入格式后沿用；日志与任务携带requestId、actor ID、task ID，禁止记录请求正文和认证头。

## 3. 身份、会话、家庭权限

> **账号关系修订**：用户与宝宝是多对多，`BabyMember` 是宝宝数据的显式权限关联，`FamilyMember` 保留家庭分组与管理职责。本文中仅按家庭授权的宝宝业务规则须结合 [08](08_ACCOUNT_BABY_RELATIONSHIPS.md) 的逐宝宝授权、邀请范围与 feed 投影；不能据此给家庭成员自动开放所有宝宝。

### 3.1 接口表

| Method/路径（均除注明外加v1前缀） | 操作/关键输入 | 结果和验收 |
|---|---|---|
| POST `/auth/register` | username/password/displayName | 创建用户和设备会话；家庭创建独立命令；同用户名并发只能成功一次 |
| POST `/auth/login` | username/password/deviceLabel | accessToken、refreshToken、sessionId、expiresIn；凭据错误不泄露账户存在性 |
| POST `/auth/refresh` | refreshToken、rotationId | 原子轮换；重放攻击撤销该会话族 |
| POST `/auth/logout` | 当前session | 撤销session、refresh和设备推送关联；其他设备不受影响 |
| GET/DELETE `/auth/sessions[/:id]` | 本人 | 列表/撤销一台设备；不能撤销他人会话 |
| GET `/me` | principal | 本人资料、可见家庭、权限版本；不默认第一个宝宝 |
| PATCH `/me` | displayName等白名单 | 不允许随意改userId/role |
| POST `/me/export` | 重新验证凭据 | 异步私有导出task，仅本人授权资源 |
| DELETE `/me` | 重新验证、共享数据处理选择 | 可查询删除任务；所有凭据失效 |
| GET/POST `/families` | 名称、timeZone | 列表/创建；创建者admin |
| GET/PATCH `/families/:id` | 成员/管理员 | 字段级权限 |
| POST `/families/:id/invites` | admin、过期时间 | 服务端随机邀请码，DB保存hash和用途；可撤销/轮换 |
| POST `/families/join` | invite code | 一次事务加入；防爆破；重复加入幂等 |
| GET/PATCH/DELETE `/families/:id/members[/:userId]` | 角色/成员 | admin管理、最后admin保护；本人退出单独动作 |
| GET/POST `/families/:id/babies` | 资料 | 显式列表/创建，创建/改资料需admin |
| GET/PATCH `/babies/:id` | baby scope | 所有下游都显式babyId；不存在/越权不返回资料 |

账号恢复固定采用一次性恢复码，不新增邮件供应商依赖。提供 `/auth/password/change`（旧密码再验证，撤销其他会话）；POST `/auth/recovery-codes/regenerate`要求近期密码再验证，一次生成10个各128bit随机code，只返回明文一次，DB RecoveryCode保存hash/userId/batchId/usedAt/revokedAt，生成新批次原子撤销旧批次。POST `/auth/password/recover`接username+code+newPassword，限流、恒定错误文案，同事务消费有效code、更新hash并撤销全部session和整个旧恢复码批次，成功后用户用新密码登录生成新码。两个并发兑换只能成功一个；响应丢失后可用新密码登录，不重新消费code。旧用户迁移后首次登录引导生成；没有已验证恢复因子时不自动重置，更不能凭“知道宝宝名字”授权。恢复码hash和明文均不得进入UserChange或日志。

邀请码固定实现：新码32字节安全随机数、base64url分享/粘贴，DB只保存`codeDigest=HMAC-SHA256(code,invitePepper)`与keyId、expiresAt/revokedAt、familyId，digest有唯一索引。pepper存部署secret，轮换时最多保留两代验证key。不能用带随机salt的密码hash再全表逐条比较邀请码。旧短码迁移到同digest映射，仅切换后7天兼容，管理员可提前撤销/换码；新码默认7天过期。join按账号/IP分别限速，错误不暴露目标家庭详情。展示邀请预览只在验证码有效后返回最少名称/邀请者信息。

### 3.2 Token和刷新算法

DeviceSession：id/userId/deviceLabel/createdAt/lastSeenAt/revokedAt/absoluteExpiresAt。RefreshCredential：tokenHash/sessionId/parentId/createdAt/expiresAt/usedAt/replacedById/rotationId。绝不存refresh明文。

access JWT默认10分钟，固定算法白名单，`iss`、`aud=baby-panel-api`、`typ=at+jwt`、`sub`、`sid`、`iat/exp/jti`；使用密钥ID支持轮换，私钥在secret manager/部署secret。每次authenticated请求查询session未撤销和user未删除；不靠长TTL正向缓存维持授权。

refresh空闲7天、会话绝对30天。客户端Keychain持久保存，刷新由actor single-flight串行完成；任何网络401最多触发一次刷新和一次原请求重试，写请求保留原幂等键。

刷新事务锁定旧credential，检查有效/所属会话；生成随机256bit successor，保存hash，标记旧used并关联successor。若同旧token再次出现：

- 同 `rotationId` 且距第一次≤60秒，返回同一次结果，处理响应丢失。短期重放结果使用部署密钥加密保存，TTL60秒，不能把token明文记录到表或日志；密钥缺失时要求重新登录。
- 其他情况撤销整个session族并返回 `REFRESH_REUSE_DETECTED`，不只撤销旧token。

客户端在第一次发refresh前先保存rotationId，收到并持久保存successor后才清除。并发两次刷新、首次响应丢失、App在落Keychain前崩溃都必须测试。宽限不是“旧token可任意创建多个successor”。

保留旧bcrypt密码hash，登录成功后按需升级Argon2id；新hash参数起点memory64MiB/time3/parallelism1并经实际机器计时确认；限制hash并发，禁止请求量直接放大内存。旧bcrypt验证在受控执行池避免阻塞事件循环。升级算法不要求批量明文密码。

### 3.3 principal 与授权事务

Principal由入口构建为 `{userId, sessionId?, authKind, scopes, requestId}`，工具闭包只能接服务器创建的principal。`babyId`目标经repository验证后得到familyId；禁止Agent任意提供已验证的principal对象。

所有家庭写事务先锁FamilySyncState行，再读取当前membership与role，再执行写；成员撤销/角色变更走同一锁。这样并发写和撤销有明确提交顺序。多家庭操作按familyId排序锁定，尽量禁止跨家庭批量写。用户数据相关事务固定先UserSyncState再按序FamilySyncState，所有调用路径一致，防死锁。

全局锁顺序补充（适用于所有事务，不能各模块自定）：`UserSyncState(按userId排序) → FamilySyncState(按familyId排序) → DeviceSession → RefreshCredential/RecoveryCode → TaskExecution → 业务实体`。只使用需要的锁，禁止取得后序锁后再请求前序锁。refresh可在事务外用tokenHash查目标userId用于定位，但必须在事务内先UserSyncState、再session/credential并重验全部状态；不能先锁credential再去写UserChange。worker事件/心跳仅锁TaskExecution，不得随后在同事务升级为family写；执行工具需开启遵守完整顺序的新事务并重新检查fence。

家庭记录事务只写通知待办outbox，不在已持有FamilyState锁时再创建接收者UserChange。notification worker按接收者分别开启User→Family→Task事务，校验成员资格后写Notification/UserChange。用户删除/家庭删除也按同顺序预先确定需锁scope集合，无法有界处理时用标记阻写+分批任务，不一次锁所有家庭大表。

读取也每次检查成员资格；无权限立即终止SSE/补发，资源内容不进入无归属缓存。后台worker每次有业务副作用前重验用户/session或OAuth grant及当前家庭资格，不能沿用任务创建时缓存的角色。

### 3.4 MCP/OAuth兼容

保留公网`/mcp`、OAuth discovery/authorize/token/revoke等既有路径；移动API token与MCP `aud=<baseUrl>/mcp` 分开校验。OAuth refresh scope只能保持或缩减；code S256、单次兑换、redirect URI精确匹配；授权撤销即时影响工具执行。

原外部客户端token是否可延续由迁移映射和验证器版本决定：可验证且归属明确的凭证保留；不能迁移的撤销并提示重新授权，不用放松audience维持表面兼容。敏感旧JWT仅设有限时间/路径兼容，不用于v1。授权页面可保留Next UI，但不再直读数据库。

## 4. 写入口与数据库模型

### 4.1 新增基础表

| 表 | 核心字段/唯一性 | 目的 |
|---|---|---|
| IdempotencyReceipt | actorId/scopeId/commandId唯一、requestHash/resultRef/resultSummary/completedAt | 命令提交证明，保留90天；永久record ID与tombstone继续防复活 |
| FamilySyncState | familyId PK、cursor bigint、epoch UUID | 每家庭提交顺序计数器和重建标识 |
| FamilyChange | familyId/cursor联合PK、entityType/entityId/version/op/payload/schemaVersion | 家庭共享实体增量；至少90天 |
| UserSyncState/UserChange | userId对应同构字段 | 私人会话摘要、通知、家庭可见性变化，不混到家庭feed |
| TaskOutbox | id、type、aggregateId、payloadVersion、nextDispatchAt、lastDispatchedAt、terminalAt | 事务到队列桥接，可reconcile |
| TaskExecution | id/kind/ownerScope/status/attempt/fenceToken/leaseOwner/leaseExpiresAt/progress/resultRef | 所有后台任务的持久执行头，覆盖snapshot/export/delete/notification与AI；不只为AI建队列 |
| AiRun/AiRunEvent/AiToolExecution | 见第6节 | 长任务、事件与工具写去重 |
| Attachment | ownerType/ownerId、familyId?/userId?、objectKey、sha256、byteSize/status | 私有对象归属与校验 |
| Notification/DeviceRegistration | userId、eventKey、readAt、deviceTokenHash/密文、environment | 站内通知和推送通道 |
| SyncSnapshot | id/scope/epoch/highWater/status/objectRef/hash/expiresAt | 大家庭全量恢复一致性 |

实体仍分喂养/睡眠等专属表，所有可同步实体新增version bigint、createdAt、updatedAt、deletedAt；family-owned实体有familyId并以复合FK确保baby/产品引用不跨家庭。不能仅靠客户端提供正确familyId。

UserChange只携带允许展示的设备/授权摘要、通知、会话元数据；**绝不输出access/refresh/PAT/邀请码/设备token、密码、credential hash或内部密钥材料**。凭据表虽是user-owned，不能把整行当可同步entity序列化。

RecordSnapshot保存更新/删除前值和来源，但不包含凭据；它用于用户撤销和审计，change用于同步。营养引用应保留录入时产品/规则版本快照，产品档案以后变更不得无声重算历史事实。

### 4.2 通用离线命令

`POST /api/v1/sync/commands`：

```json
{
  "commands": [{
    "commandId": "e6134d24-01f7-4d6e-bb2f-a7984dbd7cbb",
    "familyId": "existing-family-id",
    "babyId": "existing-baby-id",
    "entityType": "feeding",
    "entityId": "5e4db0f2-d737-459e-9fbd-867635326aca",
    "operation": "create",
    "baseVersion": null,
    "clientCreatedAt": "2026-09-11T09:00:00Z",
    "payload": {"timestamp":"2026-09-11T09:00:00Z","type":"formula","amountMl":"120","formulaProductId":"existing-product-id"}
  }]
}
```

这是契约形状样例，枚举最终必须按旧规则映射并通过golden测试，不是可在生产执行的样例。示例`existing-*`是占位引用。

支持entityType：feeding/sleep/diaper/foodLog/supplementRecord/growthMeasurement；operation=create/update/delete/restore。restore在线发起并从指定snapshot恢复，不能用任意旧payload复活。普通UI CRUD接口也转换为同一command/use-case，创建要求Idempotency-Key，更新/删除还要求baseVersion。

batch是**多个独立命令**，每项独立事务，返回200 envelope含逐项status/result/error，客户端必须逐项处理；不宣称整个batch原子。需要多记录全成全败的MCP工具调用使用另一个domain atomic-batch入口，最多20项，一个事务，禁止在事务中调用网络供应商。

依赖的精确定义：依赖关系是客户端outbox字段，不由客户端猜未来server version。父create尚未ack时，子update/delete保持`waiting_dependency`；父ack后填入真实baseVersion，再冻结并首次dispatch。选入同一次wire batch的命令必须相互独立；同一entity的多个命令不得放同批，服务器以422 `BATCH_DEPENDENCY_UNRESOLVED`拒绝这类项。依赖命令跨批ack后继续，不在一个HTTP batch里靠数组顺序推测版本；父失败时本地依赖项显示`DEPENDENCY_NOT_APPLIED`。

响应单项成功包含commandId、entityId、version、canonicalEntity或deleted marker、familyCursor、replayed；冲突包含currentVersion/currentEntity和用户草稿定位信息。不返回别的家庭内容。

### 4.3 命令算法（必须作为一份UnitOfWork实现）

1. 路由先验证schema/大小、枚举与纯输入边界；标准化payload，计算包含operation/target/baseVersion/body的canonical SHA-256，排除trace与重试时间等无关字段。
2. 开事务并锁scope state；检查user/session/membership/role、目标baby归属。
3. 查同scope+actor+commandId receipt。相同hash返回已提交结果；不同hash返回409 `IDEMPOTENCY_KEY_REUSED`。重放仍须授权；不能凭旧receipt获取已失去访问权的内容。
4. 检查依赖/现有entity。create要求ID未存在且没有deleted tombstone；update/delete/restore要求当前version等于baseVersion。不存在不悄悄变create。
5. 读取关联产品和历史规则版本、执行领域校验；保存before snapshot（适用）；update采用条件WHERE version以作第二道防线；version递增一次。
6. 增加FamilySyncState.cursor，同事务写FamilyChange完整可同步实体或删除标记；涉及多个实体逐个分配cursor。
7. 写IdempotencyReceipt及需要的TaskOutbox/Notification事件；不直接发推送/队列。
8. COMMIT；成功后才响应。提交结果未知时客户端以原commandId重试查询，不能生成新key。

事务目标<100ms，锁等待上限2s，超时返回可重试503；serialization/deadlock重试最多3次，重试整个事务，禁止内部副作用。异常不吞掉snapshot/change写失败。

### 4.4 离线冲突与实体生命周期

- 客户端先在本地一事务更新显示projection并保存outbox。server cache与pending overlay分开，收到远端变更不得覆盖未提交草稿。
- 未发出的操作可合并；第一次dispatch后body/hash/commandId冻结。服务端已处理但响应丢失时，修改重试body会变409，必须另建后续命令。
- update冲突不自动last-write-wins；返回当前值，用户可采用服务端或基于新版本重新提交。两家长不同record新增都保留，语义相似不擅自去重。
- delete是soft delete并保留UUID墓碑；restore必须在线明确操作生成新version/change，不能删tombstone以重用ID。
- 活跃睡眠`endTime=null`，结束是条件update。每baby同类活跃睡眠约束使用部分唯一索引；两台离线创建活跃睡眠冲突可见，让用户合并/结束，不自动丢弃。时长从timestamp计算。
- 离线操作窗口30天；超过窗口保留本地为“需要确认”，先全量刷新再以用户明确确认的新命令提交。不能让retention清理把仍声称可重试的旧key变成新写。
- 退出账号时默认保留加密/文件保护的本账号未同步队列，只有同账号登录才可恢复；用户可以明确删除本地草稿。清token和内存可见数据，取消请求并用session generation拒收迟到响应。不能把前一账号队列用新账号token重放。

## 5. 增量同步（关键：提交顺序）

### 5.1 不能使用普通sequence冒充安全cursor

事务A先取序号10但未提交，B取11并提交，客户端读到11后推进cursor；A随后提交10将永远被漏掉。单独`updatedAt`也不能捕获删除和同时间变更。

本方案使用**每家庭FamilySyncState行锁**：所有家庭变更事务先取得该行锁，再修改业务及cursor，持锁至提交。下一事务只有前者提交后才能分配下一个cursor。不同家庭互不阻塞；多scope按统一顺序加锁。不使用PostgreSQL sequence分配这个同步cursor。[PostgreSQL事务隔离与sequence语义](https://www.postgresql.org/docs/18/transaction-iso.html)。

此锁是家庭写入的有意串行化点；压测必须包含单热家庭，而不是只测均匀用户。禁止网络调用持锁。所有入口遵守才成立，必须设置架构/集成测试防直接绕过。

### 5.2 增量读取

`GET /sync/families/:familyId/changes?cursor=<opaque>&limit=200` 返回：

```json
{"scope":"family","epoch":"uuid","changes":[{"cursor":"42","entityType":"feeding","entityId":"uuid","version":"3","operation":"upsert","payload":{}}],"nextCursor":"opaque-token","highWater":"47","hasMore":true}
```

opaque cursor包含scope ID、epoch、position、固定highWater和schemaVersion，并签名防串scope。首次页在短读取事务取得highWater，仅分页读取 `(position,highWater]`，后续页固定highWater；完成后开始下一轮。nextCursor取本页最后已返回位置，不能在hasMore时直接跳highWater。

无变更页允许推进到已确认扫描的highWater。服务器保留retention floor，早于floor/epoch不一致返回410 `SYNC_RESET_REQUIRED`；客户端重建缓存保留outbox。按cursor升序，每条携带完整projection/删除标记，重复应用幂等；原子应用一页并保存cursor。

终页返回的nextCursor必须标为tail模式（position=本轮highWater、不再锁定旧highWater）；下一次使用tail cursor时重新取得当前highWater。中间页返回page模式，固定本轮highWater。否则客户端会永远在旧水位轮询，必须有自动测试防止这种错误。

用户feed `/sync/me/changes` 同理；家庭列表与权限每次前台恢复先从`/me`刷新，然后同步允许的家庭，失权家庭缓存清理。不同设备不会因为另一用户先读取而“领取掉”事件。

### 5.3 Bootstrap与大数据恢复

小数据和大数据使用同一快照协议，避免后面换协议：`POST /sync/families/:id/snapshots` →202 snapshotId；后台创建一致快照；`GET .../snapshots/:snapshotId`返回ready/progress及分页目录。

用户私有scope提供完全同构的`POST /sync/me/snapshots`与`GET /sync/me/snapshots/:snapshotId`，不能只给家庭做bootstrap。用户snapshot包含个人可展示配置、授权/设备摘要、通知与AI会话/run摘要；聊天message正文通过会话分页按需取，不把全部聊天/凭据塞进snapshot。所有快照页通过scope鉴权读取，page URL/ID不能跨用户复用。

首次ETL后的feed初始化固定为：可同步存量实体version=1，各Family/UserSyncState.cursor=0，epoch为本次迁移生成且记录在manifest的UUID，不为全部存量伪造业务change；初次客户端必须bootstrap后再追赶。切换后第一条真实变更cursor=1，实体修改到version2。旧客户端游标不能直接用于新epoch。

快照worker在PostgreSQL REPEATABLE READ只读事务中取得epoch/highWater以及全部同步projection；逐批按稳定PK读取并写到临时本地流文件/受控buffer，**不在数据库事务内等待上传S3**。事务时限30s，size与读速有界；超过上限明确失败，不拼凑不同时刻数据。结束事务后上传私有压缩页，写SyncSnapshot ready、每页hash/count、expiresAt(24h)。是否增大上限由5万单家记录压测决定。

客户端通过受鉴权下载接口取得各页，写新本地generation，校验count/hash全部通过后原子切换active generation并设置highWater cursor；失败保留原缓存。之后拉取highWater后的change。下载期间权限失效即停止。feed清理必须保护未过期快照的highWater或使快照失效；不能发出已无法追赶的快照。

公共知识库独立datasetVersion/contentHash同步，不挤入每家庭feed。家庭私人和用户私人数据分别输出，附件二进制不进快照，只输出Attachment引用。

## 6. 持久AI、OCR、语音、日报

### 6.1 生命周期与接口

```
queued → running → succeeded
              ├→ awaiting_confirmation → queued/running → succeeded
              ├→ failed
              └→ cancelling → cancelled
```

HTTP断连不改变run状态。所有worker结果以PostgreSQL为准，BullMQ仅调度。

| API | 语义 |
|---|---|
| POST `/ai/sessions` | 显式babyId/context，创建私人会话 |
| GET `/ai/sessions`、`/:id/messages` | 分页、私人权限；历史来自服务器 |
| POST `/ai/sessions/:id/runs` | 新message、attachmentIds、clientMessageId、Idempotency-Key；先持久消息/run/outbox再202 |
| GET `/ai/runs/:id` | 状态、attempt、lastEventSeq、最终结果、确认计划/错误 |
| GET `/ai/runs/:id/events` | SSE，支持Last-Event-ID/after；授权、序号补发 |
| POST `/ai/runs/:id/cancel` | 幂等取消请求；不会撤回已提交业务记录，返回已执行action列表 |
| POST `/ai/runs/:id/retry` | 新attempt，经状态/预算/权限检查；不能重复工具副作用 |
| POST `/ai/runs/:id/confirm` | planHash+确认动作集合+版本；原子提交已预览的工具计划 |
| POST `/medical/ocr-runs`、`/voice/runs`、`/babies/:babyId/daily-summaries/runs` | 同一任务基础设施、各自受限输入和结果schema |

禁止客户端给整个权威history；只提交新消息和context目标。图像/语音都先上传Attachment，run只接受完成且当前用户有权引用的ID。模型供应商、模型名和预算由服务端配置；用户不能传任意baseURL/命令执行字符串。

### 6.2 AiRun模型及fencing

AiRun至少：id/userId/familyId/babyId/sessionId/type/status/attempt/fenceToken/leaseOwner/leaseExpiresAt/lastHeartbeatAt/modelConfigVersion/inputRefs/resultRef/errorCode/cancelRequestedAt/budgetReservation/createdAt/startedAt/finishedAt。

物理存储规则：上面是run聚合的字段视图，status/attempt/fence/lease/heartbeat/cancel/progress/result/生命周期公共字段**只存在TaskExecution**。AiRun以相同主键一对一关联TaskExecution，仅存AI上下文/模型/预算/消息关联，不能重复存两份状态。SyncSnapshot、导出/删除及通知任务也关联TaskExecution，使用同一引擎。后文“锁run行/更新run状态/递增run序号”均指锁关联TaskExecution并事务更新聚合；事件seq也从该执行头分配。API仍以runId暴露，不影响客户端路径。

worker领取：数据库条件UPDATE仅在queued或可恢复expired状态时成功，attempt和fenceToken递增，lease默认60s每15s续租。后续event、状态与工具写必须验证runId+fenceToken仍当前，使用DB时间判断；旧worker即使Redis锁过期后继续输出，也不能写入新attempt。worker按任务类型有独立并发限额，模型网络请求不能占DB连接。

AiRunEvent `(runId,seq)` 唯一，seq由run行锁/条件更新分配；类型包括run_started、text_delta、tool_proposed、tool_started、tool_succeeded、awaiting_confirmation、attempt_restarted、run_failed、run_cancelled、run_succeeded。text_delta按200ms或约2KiB批量持久再投递，不逐token写库；未落盘最后一小段不显示为可靠结果。

固定SSE wire：`id: <seq>`、`event: <type>`、`data: {"runId":"...","seq":"42","attempt":1,"type":"text_delta","payload":{"text":"..."}}`，以空行结束；seq为十进制字符串，在同run跨attempt持续递增。`Last-Event-ID`仅对此URL的run有效，提供after与header冲突时400。终态也是typed event，不再使用未定义`[DONE]`哨兵；旧Web兼容适配器负责转换。parser必须处理UTF-8字符跨chunk、多行data、注释心跳、重复seq和部分最后一帧。

事件终态至少保留7天，最终消息与工具结果按用户数据策略保留；事件过期返回410 `RUN_SNAPSHOT_REQUIRED`，客户端读取完整run和消息。SSE15s注释心跳、代理禁buffer、写背压；慢客户端队列64KiB封顶后断开让其补发，不无限堆内存。

### 6.3 PG事务outbox → BullMQ → reconcile

事务创建run和TaskOutbox。不在数据库事务中调用`queue.add`。dispatcher每秒批量领取最多100个到期outbox，用`FOR UPDATE SKIP LOCKED`/短lease，提交后再投递稳定jobId（例如runId及attempt，不用冒号）。投递后标lastDispatchedAt；投递成功但回写失败允许重复。

每30s扫描PG中queued且长时间未开始、lease过期和未终态outbox，重新协调队列。Redis重建后同样重投：PG行的状态/幂等才决定能否执行，不能因`dispatchedAt`存在就永久不再投递。run终态和outbox terminal标记在同一个PG事务提交。

调度确认只是outbox的短领取lease，不能替worker开始执行时取得的TaskExecution lease。通用引擎必须先于snapshot功能落地；AI适配只是其后的processor，不允许同步模块再造一个进程内任务引擎。

BullMQ retry负责传输/基础设施恢复，业务attempt由PG决定；不要两层各重试3次形成9次收费。`attempts`与`maxStalledCount`在adapter统一配置并测试。队列结果TTL和清理规则不能破坏PG重试资格。[BullMQ stalled](https://docs.bullmq.io/guide/jobs/stalled)、[幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs)。

### 6.4 工具执行、确认与取消

写工具先生成稳定 `AiToolExecution(actionId,runId,planHash,target,expectedVersion,status,resultRef)`。iOS聊天默认进入awaiting_confirmation，显示具体宝宝、时间、数量、将新增/修改/删除哪些内容；确认输入只选已存计划，不接受替换payload。确认前重新验证版本/成员权限，有变化回409需要重新预览。

确认的多个同家庭动作以一个领域atomic-batch事务完成，business rows、receipt、snapshot、change、tool结果一起提交；actionId是幂等键。重复确认/worker重试不会重复记账。MCP显式授权可跳过App确认UI，但仍走同一action/transaction和scope检查。

等待确认默认30分钟有效，TaskExecution进入awaiting_confirmation时释放lease，BullMQ当前processor结束，不占并发槽、不续心跳。reconcile只恢复queued和过期running，绝不能把awaiting_confirmation当卡住任务自动执行。确认事务验证planHash/expiry，使用User→Family→TaskExecution固定锁顺序完成工具业务提交并写结果，若还需模型总结则将task置queued并新增带phase/attempt的outbox；否则直接succeeded。已确认action结果是重试凭据，不重新生成计划重复写。过期计划标failed `CONFIRMATION_EXPIRED`并保留草稿，可由用户发起新计划。

TaskOutbox增加phaseKey和dispatchState(active/parked/closed)：awaiting_confirmation时当前phase parked；确认后旧phase closed，新phase active。非终态不等于所有phase都应反复投递；reconcile须同时检查task状态和phase资格。唯一 `(taskId,phaseKey)`，当前调度phase之外的迟到job通过状态/fence校验拒绝。

取消与写事务用固定锁顺序协调（User/Family state → run），写之前检查cancelRequested和fence。取消不能承诺撤销已提交动作；UI必须显示这些动作并提供单独undo。读模型调用尽可能AbortSignal终止，但供应商可能仍计费，usage保持pending/unknown并随后对账。

取消事务将非终态task置cancelling、记录cancelRequested并递增fence使旧worker立即失去写资格；随后关闭当前outbox phase，取消协调器最多30秒内写cancelled终态并列出已有action receipts。已有终态返回该终态不倒退。发给provider的abort和BullMQ remove是best effort，不作为阻止后续数据库工具写入的唯一机制；provider未知费用记录在独立attempt usage对账，不允许旧worker重新覆盖run终态。

外部副作用无法被本地DB事务回滚：供应商支持idempotency key则使用，不支持时在“请求已发出但结果未知”状态不盲重试非幂等动作，进入待确认/人工处理。APNs允许重复提示，但notification ID与点击目标唯一，业务记录不重复。

### 6.5 重试和预算

默认模型连接超时10s、无进度60s、文本run总时限180s、OCR/语音300s；provider429遵守Retry-After，网络临时错误指数退避带抖动，上限3个自动attempt。认证/输入/权限错误不自动重试。已部分输出的attempt重启显示明确新attempt/替换草稿事件，不能把两次生成文本拼接伪装一次完整答案。

每用户同时最多2个AI run，按家庭/全局还有限制；提交前在PG事务预留预算，供应商调用前记录attempt usage，结束清算。模型token/搜索/ASR调用额度分别计量；缺少密钥明确503，不生成假结果。需要同机ASR时仅允许管理员预配置固定程序与参数模板、无shell拼接、超时/CPU内存限制，模型不能指定执行命令。

日报、提醒任务以`family/baby/localDate/type/configVersion`唯一，统一服务端时区；事件更新后派生摘要失效，前台展示计算版本/时间。营养确定性计算可同步或按version缓存，AI日报独立异步，不能因AI不可用阻断记录。

## 7. 附件、报告和通知

### 7.1 附件协议

1. POST `/attachments`：purpose、MIME、byteSize、sha256、owner scope；鉴权后创建pending对象，返回attachmentId和限定key/大小/有效期的上传能力。图片≤20MiB、语音≤25MiB为初始上限；支持类型由schema白名单定义。
2. 客户端上传同一object key，失败重试；上传URL过期通过本人`/:id/upload-url`续签。不得由客户端任意给object key或读取其他key。
3. POST `/:id/complete`：服务端HEAD及必要读取校验大小/hash/魔数、受限解码；只验证成功转ready。etag不等于通用sha256。未经完成不进入OCR。
4. GET `/:id/content`：服务器按个人或家庭归属鉴权后流式从S3读取。医疗原件默认使用这个受保护代理，不暴露长期签名读URL；取消/背压传播到对象流，禁止一次读取整个大文件到内存。
5. DELETE `/:id`：检查引用和权限，标delete_pending+outbox；对象删除幂等；引用还存在时禁止直接删共享对象。未完成孤儿24h清理，已完成未引用7天提醒/清理策略需用户可见。

原public文件迁到private bucket后删除公开映射/代理路径；保留旧URL到attachmentId的受鉴权兼容映射。worker读取私有对象时同样验证owner/run关系，不能用任意HTTP地址触发SSRF。

### 7.2 医疗结果与资料

OCR result是结构化草稿，包括原文/字段置信度/参考单位/模型来源，用户确认才写MedicalReport/GrowthMeasurement；确认事务检查attachment+baby+run归属。报告输入不自动覆盖WHO/营养规则，医疗参考值与用户真实值分开。编辑/删除/恢复都产生快照与change，不能让AI通过按ID delete绕开服务。

### 7.3 推送和通知

`PUT /devices/:installationId/push` 注册APNs token，unique(platform,environment,tokenHash)，归属当前session/user；换账号解绑旧关联。敏感token加密，sandbox和production不混用。`DELETE`退订。Web Push endpoint继续兼容但采用同一通知事件。

Notification按`recipientUserId,eventKey`唯一；`GET /notifications`分页；`POST /notifications/:id/read`幂等，写UserChange同步多设备已读。提醒scheduler扫描到期事件并写Notification/outbox，数据库唯一键防多scheduler重复。

APNs失效token禁用；429/5xx退避，4xx永久失败分类而不无限重试；推送失败不回滚喂养记录。用户偏好、安静时段和baby归属在发出前再校验；默认文案“有新的照护记录/任务已完成”。Deep link导航前刷新权限。

## 8. 查询性能与缓存的实现规则

- 每个查询都要求scope和有界时间区间。timeline从第一版建立事务维护的TimelineEntry投影，不能把所有历史拉到Node内存排序。
- TimelineEntry(scope/baby/entityType/entityId/occurredAt/version/deletedAt/summary)与写事务一致维护；正文仍专属表。索引(babyId,occurredAt DESC,id DESC) WHERE deletedAt IS NULL；cursor含时间+ID。
- 营养/日统计使用半开区间 `[dayStartUTC,nextDayStartUTC)`，按family时区计算；不在索引列上逐行做日期格式化过滤。DST测试不能省。
- 缓存key包括family/baby/date/recordVersion或datasetVersion。权限在读缓存前检查；先使用版本key避免跨实例主动失效丢失。缺缓存直接回源，不改变结果。
- 查一次`/me`不能include全部历史；API不得N+1加载每条record的产品与作者；使用select/batch，schema response白名单防意外返回passwordHash。
- DB连接池预算、AI并发、SSE上限与CPU压测见05。SQL优化要附EXPLAIN证据，而非声称“加索引就快”。

依赖降级：`/health/live`只检查进程；API `/health/ready`检查PG、schema兼容及认证配置。Redis queue/S3/供应商故障单列degraded，不把不依赖这些服务的照护记录API全部摘除。PG仍可接受有容量限制的AI queued任务；积压达到每用户/全局上限返回429/503，不能无限堆积。cache Redis失效时只读回源并限并发；登录/恢复/高成本AI的分布式限流失效则该入口fail closed，已登录低成本记录入口用有界进程保护继续服务。所有降级计数可观测，恢复不需手工清数据。

## 9. 后端验收样例（必须自动化）

| ID | 场景 | 必须断言 |
|---|---|---|
| B-01 | 50并发同命令新增 | 1实体、1有效feed变化、1receipt，全部响应同结果 |
| B-02 | 同key不同amount | 409，原记录不变 |
| B-03 | 提交成功后丢响应再重试 | 不重复记账，客户端收敛到canonical |
| B-04 | 两个baseVersion=1同时改 | 仅1次到version2，另一次409保留草稿 |
| B-05 | change/outbox写故障 | 业务entity也回滚 |
| B-06 | 家庭A请求家庭B的报告/附件/run | 全路径拒绝，日志无B正文 |
| B-07 | 写事务A暂停、B同时写同家庭 | B不能先获得较大cursor提交导致漏A |
| B-08 | 正在bootstrap时持续增删改 | 最终bootstrap+changes与服务端投影逐ID/version一致 |
| B-09 | 成员撤销与工具执行并发 | 按锁提交顺序处理，撤销后无新越权写 |
| B-10 | worker在工具提交后崩溃 | 恢复任务不重复写工具结果对应的记录 |
| B-11 | 清空隔离Redis queue | reconcile从PG恢复非终态，结果无重复 |
| B-12 | refresh响应丢失和两设备重放 | 宽限同rotation回同结果，恶意重放撤销 |
| B-13 | 200慢SSE客户端 | 内存有界，事件可补发，普通API延迟不崩溃 |
| B-14 | 账号切换后旧HTTP返回 | 原生旧generation拒收，队列不会换身份发送 |
| B-15 | 删除/账号删除后备份恢复 | 删除账本重放，不复活应删除内容 |
| B-16 | 同一源数据经REST/MCP/AI确认写 | 同等校验、snapshot、change、source审计全部存在 |

实现任务清单不得删掉这些失败场景来换“测试全绿”。不会实现某项时报告最小失败用例与待决定事项，由review定位，不允许临时绕过。

## 10. 全领域路由登记与契约输入来源

下面补齐非基础协议的资源族，统一给04/BE-10使用；全部加`/api/v1`。POST创建用Idempotency-Key，PATCH/DELETE带baseVersion；具体字段的唯一源由BE-01从旧types/service和本表生成并冻结，不由每个页面单独猜测。

| 资源 | 固定路径/动作 | 字段/规则来源与边界 |
|---|---|---|
| 时间轴 | GET `/babies/:babyId/timeline` | TimelineEntry keyset；kind/from/to有界筛选；不叫feed以免混淆sync feed |
| 喂养/睡眠/尿布/辅食/补剂记录 | GET/POST `/babies/:babyId/records/{feeding,sleep,diaper,food,supplement}`，PATCH/DELETE `.../:recordId` | 对应02命令entityType；旧`lib/records/service.ts`、`types/`、nutrition records校验；共享command入口 |
| 成长 | GET/POST `/babies/:babyId/growth-measurements`，PATCH/DELETE `.../:id`；GET `/babies/:babyId/growth-chart` | date/weightKg/heightCm/headCircumferenceCm至少一项测量；百分位/年龄服务器计算 |
| 成长OCR | POST `/growth/ocr-runs` | attachmentId+babyId，返回run；确认后调用growth用例，状态与medical OCR一致 |
| 奶粉/补剂产品 | GET/POST `/families/:familyId/nutrition-products`，PATCH/DELETE `.../:id` | discriminated type=formula/supplement，复用旧产品字段/营养单位；删除优先归档，历史引用快照不变 |
| 补剂计划 | GET/POST `/babies/:babyId/supplement-schedules`，PATCH/DELETE `.../:id` | frequency/startDate/localTime/dose/productId；修改在线，按family时区 |
| 营养 | GET `/babies/:babyId/nutrition/analysis`、`/nutrition/trends` | from/to/datasetVersion，确定性值和估算值区分，母乳折算标来源，不写第二套临床规则 |
| 辅食计划 | GET/POST `/babies/:babyId/food-plans`，PATCH/DELETE `.../:id` | 计划在线更改，辅食记录可离线；foods/portion/acceptance按旧枚举映射 |
| 疫苗 | GET `/babies/:babyId/vaccines/schedule`；GET/PUT `/babies/:babyId/vaccine-selections`；GET/POST/PATCH/DELETE `/babies/:babyId/vaccine-records[/:id]` | scheduled/completed date、strategy/source版本；正式提交在线，离线可编辑本地草稿 |
| 病历 | GET/POST `/babies/:babyId/medical-reports`，GET/PATCH/DELETE `.../:id` | 原category、items/hospital/notes、Attachment引用；正式写在线；AI摘要不可伪装原始检查结果 |
| 日报 | GET `/babies/:babyId/daily-summaries`；POST `/babies/:babyId/daily-summaries/runs` | 日期/数据版本/生成模式，返回通用GET `/ai/runs/:id`可查询run；实际调用同一个daily-summary processor，不另建`/runs/:id` |
| 解析 | POST `/ai/parse-runs` | parse-record/parse-nutrition 两种kind，统一异步run与动作/草稿确认；非同步假AI接口 |
| 语音 | POST `/voice/runs`；GET `/voice/logs`；PATCH `/voice/logs/:id` | 受授权附件、ASR、识别记录建议、已读；整个pipeline同一个durable run |
| 知识库 | GET `/knowledge/{foods,feeding-guidelines,books,milestones,warning-signs,activities,vaccines}` | static datasetVersion、source引用、按年龄等过滤；不要新增不存在的用户里程碑打卡数据 |
| 家庭食材/绘本状态 | PUT `/families/:familyId/food-status/:foodId`、`/book-status/:bookId` | 已尝试/收藏/阅读等实际状态，含baseVersion；在线更新 |
| 天气 | GET `/weather` | 显式经纬度或城市二选一，严格范围/超时/缓存，provider key服务器持有 |
| 通知偏好 | GET/PUT `/me/notification-preferences` | 时区/安静时段/kind开关，可选baby scope；更新进入UserChange |
| 外部授权管理 | GET `/connections`、DELETE `/connections/:grantId` | 本人OAuthConsent/client/scopes只读摘要与撤销；不是OAuth authorize/token端点 |
| PAT管理 | GET/POST `/me/tokens`、DELETE `/me/tokens/:id` | scope/expiration/name，明文只首次创建响应；和移动session/OAuth凭证三者分开 |
| 使用情况 | GET `/me/ai-usage` | 聚合本人的run/工具/费用/额度，明示estimated/final；新增完整预算功能，不声称旧Web已有相同API |
| 配置 | GET `/app-config` | 可公开/当前用户可见的feature/protocol/minimum-client版本；任何供应商密钥不得返回 |
| 附件选择 | GET `/attachments?scope=...&purpose=...` | 仅分页索引当前有权附件供已有上传场景选择；独立全图库产品为可选增强 |

同资源REST update与sync命令payload使用同一Input schema，不允许两条入口对同字段采用不同单位/默认值。自动工具写入使用服务端固定source（ui_manual/ai_chat/mcp/voice等映射表），不能接受客户端冒充Gemini Spark或其他author。

BE-01必须输出`FIELD_MAPPING.md`：逐资源列“旧字段/旧类型/目标字段/目标类型/单位/null默认/枚举/验证/客户端是否可写/对应golden case”。至少覆盖所有已有可写字段，不得省略奶粉选择、左右母乳时长、补剂单位、辅食异常、夜醒、报告原图和来源引用。

最低golden集合：每类记录正常/最小/最大/缺值/非法值/未知枚举；birthday前、未来界限、Asia/Shanghai跨日、DST切换；小数边界和0/null区别；产品归档后历史营养不变；相同原数据经旧接口与v1 DTO投影按映射一致。发现旧行为本身错误时另写差异决策，不为“兼容”保留越权或错误单位。

## GrowDesk 独立仓库交接补充（路径调整）

服务端 schema/export 归 growdesk-server；IOS01 消费已验收导出，在 growdesk-ios 的 `Contracts/openapi.json` 固定快照，并用 `Contracts/source.json` 记录源仓库、commit、契约版本与 SHA-256。生成客户端及 CI 只读取该快照，不依赖相邻目录或浮动分支。契约变更分别记录两仓库 commit 和验证结果；不维护第二套手写 DTO。BOOT/BE/DB/OPS 在服务端实施，IOS 在原生仓库实施；BE-12 涉及旧 Web 的部分须单独限定修改范围并提供该仓库的 diff/证据。详细入口见 growdesk-server 根 START_HERE.md。
