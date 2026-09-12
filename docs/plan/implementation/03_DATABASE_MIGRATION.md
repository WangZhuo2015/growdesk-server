# Baby Panel PostgreSQL 18 数据库迁移实施计划

> **账号与宝宝多对多修订**：目标新增 BabyMember 关联与约束。旧 FamilyMember→Baby 的有效访问需显式回填，不能因新模型丢失权限，也不能让以后新加入的家庭成员自动获取所有宝宝。迁移步骤、角色及共享数据删除规则以 [08](08_ACCOUNT_BABY_RELATIONSHIPS.md) 为准。

> **2026-09-11 产品决策更新**：应用正常联网，可选择数据仅本机保存；云同步/协作需主动授权。涉及登录前置、仅缓存、本地保留和“必须联网”的规则以 [07 本地保存与按需云协作](07_LOCAL_FIRST_OPTIONAL_SYNC.md) 为准；云端事务、权限与幂等不变量继续有效。

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


日期：2026-09-11

状态：规划稿；本文件只描述迁移设计和验收，不代表任何数据库、应用代码、环境变量或生产服务已经改变。
范围：现有 Web SQLite 数据作为迁移源；目标固定为 PostgreSQL 18 + Prisma 7 + `@prisma/adapter-pg`。iOS、API、worker 的总体架构见同目录其他方案；本文件只负责数据库、ETL、切换和数据证明。

## 0. 阅读规则与硬边界

文中用“代码事实”标出已从仓库静态检查得到的情况，用“迁移建议”标出尚未实施的设计。静态检查没有连接生产库，也没有读取 `.env`、密码、token、数据库内容或文件内容中的秘密；因此本文件不对生产行数、线上附件数量、现行流量或 PostgreSQL 可用性作断言。

本次整理仅迁移计划，不执行数据库操作。后续 Agent 按明确领取的任务在 growdesk-server 实现并验证；不能修改旧 Web 数据源或连接生产。标为 `【拟新增未存在】` 的命令表示尚未验收的目标接口：部分名称已有声明，仍需核对脚本文件、隔离保护和实际行为。

固定决策如下：

1. 目标数据库为 PostgreSQL 18；目标 Prisma provider 为 `postgresql`，运行时使用 `pg.Pool` + `PrismaPg`，不继续以 LibSQL adapter 作为目标连接层。
2. 现有 SQLite migration history 只用于了解历史和数据形状，不能当作 PostgreSQL migration history 执行或复制。目标在 `prisma/schema.prisma` 和 `prisma/migrations/` 建立全新的 provider 边界。
3. 目标为独立 growdesk-server 仓库根 npm workspace。当前已有 packages/domain、database、contracts 骨架，apps/api、worker、scheduler、adapters、Prisma 配置和 PostgreSQL migrations 尚需实现；不得重复生成覆盖已有包。旧 Web 根目录不搬动。
4. 所有需要同步的业务表从首版就保留 scope（family-owned 为 `familyId`，user-owned 为 `userId`）、按实体独立递增的 `version` 和 `deletedAt`；family-owned 表另外保留复合归属键。`FamilySyncState.cursor` 是家庭 change feed 的提交位置，不能与任何实体的 `version` 混用。`TimelineEntry` 是从首版建立的事务投影，不能在迁移后靠定时扫描补算。每次业务写、timeline projection、change 和 task outbox 必须在一个数据库事务里完成：先锁 state 行，再在同一事务中重验授权；实体 version 和 scope cursor 分别分配。
5. 权限主路径是显式、已验证的 principal-scoped repository 加复合外键；当前不把 RLS 作为首发硬依赖。若以后开启 RLS，必须另写 ADR、策略测试和回退方案。
6. 首次切换采用统一停写栅栏、排空已接受写入、最终全量一致快照和 checkpoint 审计；源 journal/CDC 不作为首发依赖。任何无法解释的行、哈希、附件、游标、实体 version 或 checkpoint 都是停止条件。

## 1. 已核实的源系统与目标边界

### 1.1 当前源系统（代码事实）

| 证据 | 当前情况 | 对迁移的影响 |
|---|---|---|
| `prisma/schema.prisma:6` | datasource provider 是 `sqlite`，共 47 个 model | 不能把 schema 里的 provider 直接改成 PostgreSQL 后当成数据迁移完成 |
| `prisma/migrations/migration_lock.toml` | `provider = "sqlite"` | 新目标必须有独立 migration lock 和目录 |
| 当前 migration 目录 | `20260824120000_baseline`、`20260826120000_add_ai_chat_sessions`、`20260827120000_add_missing_indexes`、`20260827130000_add_growth_clientid`、`20260903140000_sync_schema_and_formula_default`、`20260904080000_security_pat_hash_fk_cleanup` | SQL 含 `PRAGMA`、`DATETIME` 和 SQLite table rebuild，不能跨 provider 重放 |
| `prisma.config.ts` | 默认 `file:./dev.db`，对 `file:` 路径做本地解析 | 新 workspace 要有自己的 `prisma.config.ts`，用 PostgreSQL URL，不能继承文件数据库 fallback |
| `lib/prisma.ts` | 使用 `@prisma/adapter-libsql`；对 SQLite 设置 WAL、busy timeout、foreign keys，并有 `IS_TEST` 的文件库保护 | 这些 PRAGMA 不可搬到 PostgreSQL；测试熔断要改为数据库名/角色/主机的 allow/deny 检查 |
| `package.json` | Prisma/client 为 7.9.1，依赖 `@prisma/adapter-libsql`，尚无 `@prisma/adapter-pg` 和 `pg` | 目标 backend workspace 需要独立锁定并验证 `@prisma/adapter-pg`、`pg`、`dotenv` |
| `scripts/backup-db.sh` | 通过 Python `sqlite3` 的只读源连接和 `src.backup(dst)` 复制，之后 `quick_check` | 这是源快照的可复用思路；不能用 `cp prod.db` 绕过 WAL |
| `scripts/test-api.sh`、`.env.test` 约定 | 使用 `dev_test.db`、临时端口 3089、测试 tenant 清理 | PostgreSQL runner 验证前继续按此规则；不能因为开始设计 PG 就让现有测试改连生产或半成品 PG |
| `lib/outbox.ts` | IndexedDB 队列按 `clientId` 去重；当前 4xx 会从队列移除 | 迁移时不能把这个行为当成目标服务端的可靠 outbox；应由 `IdempotencyReceipt` 和 `TaskOutbox` 接管，并保留失败项审计 |
| `lib/archive.ts` 与上传路由 | `AiArchive` 记录 `contentHash`/`filePath`；图片和音频在 `data/archive/YYYYMM/`，业务图片还使用 `/uploads/...` | 数据行和文件对象必须共用 manifest、hash、归属和访问校验对账 |

上述只是仓库事实。没有从这些事实推导“生产当前有多少数据”“备份一定可恢复”或“目标 PostgreSQL 已存在”。

### 1.2 目标 workspace（迁移建议）

```text
GitHub/
  baby_panel_for_cecilia/          # 旧 Web 参考，SQLite 迁移源
  growdesk-server/                # 新目标，独立 Git/npm 根
    package.json                  # 已有 workspace 声明
    packages/{domain,database,contracts}/  # 已有骨架
    packages/{adapters,testkit}/   # 待实现
    prisma.config.ts              # 待实现
    prisma/schema.prisma          # 待实现，provider = postgresql
    prisma/migrations/            # 待实现，PostgreSQL 独立历史
    apps/{api,worker,scheduler}/   # 待实现
    docs/plan/                    # 本规格包
  growdesk-ios/                   # 独立原生仓库
  growdesk-android/               # 本计划不含 Android 实现任务
```

Prisma 7 的目标配置应遵循旧参考仓库 `.agents/skills/prisma-database-setup/SKILL.md`（存在时读取）及 Prisma 官方文档 的连接边界：schema 的 datasource 只写 `provider = "postgresql"`，URL 由 `prisma.config.ts` 通过 `dotenv/config` 读取；运行时使用 `pg` 与 `@prisma/adapter-pg`（例如经实际生成路径导入 `PrismaPg`），每个进程只建立一个 PrismaClient/pool。不得使用 `new PrismaClient()` 空构造，也不得使用 Prisma 7 已不接受的 `datasourceUrl`。关闭时必须先由 BOOT-01/DB03 的隔离 bootstrap 验证实际 adapter 的 pool 所有权，再选择唯一的 shutdown owner；不能无条件同时调用 `prisma.$disconnect()` 和外部 `pool.end()`，避免双重关闭。bootstrap 至少验证 `SELECT 1`、数据库/角色/版本、事务回滚和只关闭一次的生命周期；这些是未来实施约束，不是当前代码状态。

## 2. 现有 47 个 model 的完整盘点

下面的分类覆盖 `schema.prisma` 中的每一个 model。分类只描述迁移语义，不改变表名或业务含义。初次导入优先保留原表语义；新增同步、任务和附件模型另按第 3 节设计。

### 2.1 身份、租户和家庭边界（4）

| model | 现有用途 | 迁移处理 |
|---|---|---|
| `User` | 账号、密码哈希、显示名、时间 | 保留 `id`、`username`、`passwordHash`、时间；`passwordHash` 按不透明字符串逐字校验，不读取或反推出密码 |
| `Family` | 家庭租户、邀请码 | 保留 `id`、家庭根归属；源 `inviteCode` 只在受控 staging 短暂读取，目标保存邀请码 hash/版本/用途/有效期/撤销状态，不保存 plaintext |
| `FamilyMember` | user-family 成员、role、relation | 保留复合唯一 `(familyId,userId)`；迁移后给受保护 repository 提供成员范围 |
| `Baby` | 家庭内宝宝档案、生日、头像路径 | 保留 `id` 和 `familyId`；`birthDate` 按纯日期转换；头像 URL 进入附件对账 |

### 2.2 家庭业务记录和恢复审计（13）

| model | 现有用途 | 迁移处理 |
|---|---|---|
| `FeedingRecord` | 喂养事件、奶量、来源、离线 `clientId` | `timestamp` 转 instant；保留 `clientId` 作为历史来源键；只有可证明 actor/body hash 的新协议请求才形成 receipt |
| `SleepRecord` | 睡眠开始/结束 | 两个时间都转 instant；校验结束不早于开始 |
| `DiaperRecord` | 尿布事件和便便属性 | `timestamp` 转 instant；枚举先 text + constraint |
| `GrowthMeasurement` | 体重/身高/头围测量 | `date` 转 date；浮点量转 numeric；图片进入附件映射 |
| `MedicalReport` | 医疗报告、OCR 摘要、图片路径 | `date` 转 date；`itemsJson` 转结构 JSONB，同时保留原始序列化证明 |
| `FoodLogRecord` | 辅食记录、食物列表和接受度 | `date`/`time` 作为家庭时区的 date + wall-clock time；`foods` 转 JSONB |
| `FoodPlan` | 辅食计划 | `date` 转 date；tags/ingredients/steps 转 JSONB，nutrition 仍为文本 |
| `VaccineRecord` | 宝宝实际预约/完成疫苗 | scheduled/completed 转 date，不将无时区日期伪造为 UTC instant |
| `VaccineSelection` | 家庭对可选疫苗的选择状态 | 保留 `(babyId,vaccineId,doseNumber)` 唯一性 |
| `SupplementSchedule` | 补剂频率、开始日期、提醒时间 | `startDate` 为 date，`reminderTime` 为无时区 time；JSON days 转 JSONB |
| `SupplementRecord` | 补剂实际服用 | `date` 为 date，`time` 为无时区 time；剂量转 numeric |
| `AgentVoiceLog` | 语音/Agent 交互反馈 | 保留正文和 user/baby 归属；没有把它当作持久 AI worker 运行记录 |
| `RecordSnapshot` | 删除/更新前的恢复快照 | 保留原始 payload 和 hash；它是撤销审计，不等同于 `SyncSnapshot` |

### 2.3 家庭配置、状态和推送（5）

| model | 现有用途 | 迁移处理 |
|---|---|---|
| `FormulaProduct` | 家庭奶粉产品、营养成分 | family-owned；剂量/比例转 numeric，`nutrientsJson` 转 JSONB |
| `SupplementProduct` | 家庭补剂产品 | family-owned；剂量转 numeric，营养 JSON 转 JSONB |
| `FamilyFoodStatus` | 家庭食物已尝试/待尝试 | family-owned；`firstAddedDate` 转 date；保留 `(familyId,foodId)` |
| `FamilyBookStatus` | 家庭绘本阅读/收藏 | family-owned；保留 `(familyId,bookId)` |
| `PushSubscription` | Web Push endpoint 和 keys | endpoint 保留；keys 视为敏感 JSON，迁移到 `DeviceRegistration` 的受保护字段，不写日志 |

### 2.4 静态参考和知识库（15）

| model | model | 迁移处理 |
|---|---|---|
| `DataRelease` | 参考数据发布批次 | 作为静态 reference，保留 `asOf` 为 date |
| `SourceRef` | 文献/来源 | `publicationDate`、`accessedDate` 为 date；保留 `sourceId` |
| `Vaccine` | 疫苗静态主数据 | 保留 `vaccineId`；数组/对象字段转 JSONB |
| `VaccineDose` | 疫苗剂次规则 | 保留 `vaccineId` 关系；剂量体积转 numeric |
| `VaccineSourceRef` | 疫苗与来源连接表 | 保留连接表 ID 和双外键 |
| `VaccineStrategyGroup` | 疫苗策略组 | 保留 `strategyId`；options/source refs 转 JSONB |
| `VaccineScheduleEntry` | 年龄/剂次日程 | source refs 转 JSONB；关联 vaccine ID 仍需 FK/校验 |
| `ScheduleEngineRule` | 日程引擎规则 | 保留 `ruleId`；vaccine IDs/source refs 转 JSONB |
| `DevelopmentMilestone` | 发育里程碑 | 保留 `milestoneId`；source refs 转 JSONB |
| `MilestoneSourceRef` | 里程碑与来源连接表 | 保留双外键关系 |
| `DevelopmentWarningSign` | 发育警示信号 | 保留 `warningSignId`；source refs 转 JSONB |
| `FeedingGuideline` | 喂养指南 | 四类内容和 source refs 转 JSONB |
| `FoodItem` | 食物静态库 | 保留 `foodId`；准备/营养/年龄纹理/来源转 JSONB |
| `Book` | 绘本静态库 | 保留 `bookId`；作者、分类、互动建议等转 JSONB；评分转 numeric |
| `ActivityRecommendation` | 活动建议 | categories、steps、安全条件等转 JSONB |

静态表不携带家庭权限，但仍必须先导入再建立依赖外键；不把静态 JSON 拆成 EAV。数据文件 `data/01_sources.json` 至 `data/06_activities.json` 是 seed/reference 输入，不是生产业务行的替代品。

### 2.5 AI、聊天和归档（4）

| model | 现有用途 | 迁移处理 |
|---|---|---|
| `AiJob` | OCR/异步任务的现有记录 | 迁移到 `AiRun` 的 legacy source，保留 ID、状态、结果和结束时间；不能据此宣称旧进程任务可恢复 |
| `AiArchive` | append-only 文本/图片/音频审计归档 | 保留 `id`、kind、`contentHash`、byteSize、filePath/content；文件实体进入 `Attachment` 或 archive storage |
| `AiChatSession` | AI 会话头 | 保留 session ID 和 user/baby 归属；必要时关联新的 run，不能强行等同 run |
| `AiChatMessage` | 聊天消息与工具轨迹 | 保留 message ID、序列时间、正文；`toolsJson` 结构化后存 JSONB，原串要可追溯 |

### 2.6 OAuth、凭据、安全和审计（6）

| model | 现有用途 | 迁移处理 |
|---|---|---|
| `OAuthClient` | MCP/OAuth 动态客户端 | 保留 `clientId`；secret 只作为敏感不透明值处理，不能出现在 manifest/日志 |
| `OAuthAuthorizationCode` | 一次性授权 code | 默认在切换前使未兑换 code 失效并要求重新授权；若要迁移必须逐条检查过期、PKCE 和 client 归属 |
| `OAuthRefreshToken` | 外部 MCP/OAuth refresh token 哈希和授权范围 | 保留在 OAuth 专属命名空间/表，按 OAuth policy 保留或撤销；绝不映射为首方 `RefreshCredential`，也不接受为移动 API token |
| `OAuthConsent` | 用户、客户端、宝宝授权记录 | 保留三元归属与 scope；目标采用显式 principal 校验 |
| `OAuthAuditLog` | OAuth/MCP 审计，不直接关联用户 FK | 保留 request/action/result/status 等审计字段；需单独制定 retention，不能用测试 tenant purge 清理 |
| `PersonalAccessToken` | 快捷指令 PAT | 保留 `tokenHash`、hint、时间和 user 归属；不读取或恢复明文 token |

所有 47 个 model 的 `id` 都必须进入 mapping manifest；任何源 ID 不能转换成功、发生重复或与目标已存在值冲突时，进入 quarantine，不可静默生成新 ID。旧实体 ID 的目标列以 `text` 为优先兼容形状，保留原值；只有新建的非 legacy 实体才由应用生成 UUIDv4 字符串。不能假设历史 SQLite 行全部是合法 UUID。

## 3. 目标新增实体及同步语义

### 3.1 新实体清单

以下实体来自总体架构方案，当前 schema 中不存在。它们不是把旧表改名，而是为移动端离线、任务恢复和跨设备通知补齐可靠性。

| 目标实体 | 归属/用途 | 初次导入策略 |
|---|---|---|
| `DeviceSession` | user、设备、access session、撤销时间 | 源无同构表；切换后重新签发，避免把浏览器 cookie 当移动 session |
| `RecoveryCode` | user、batch、一次性恢复码 hash、使用/撤销状态 | 源无同构恢复码来源；迁移后首次登录在受控事务中生成每批 10 个 128-bit 一次性 code；只保存 hash，code/password/session 恢复事务原子提交，hash 不进入 feed |
| `RefreshCredential` | 首方 refresh token 哈希、轮换、重放检测 | 源无同构首方凭据；切换后由首方登录/会话流程重新签发。不能把 `OAuthRefreshToken` 的 hash 导入此表；旧首方凭据若另有来源，必须按首方 policy 单独证明后再决定 |
| `IdempotencyReceipt` | 请求键、principal/family、请求 hash、结果引用 | 只承载新协议或完整可还原 actor/body hash 的请求证明；旧 `clientId` 不足以生成可成功 replay 的 receipt |
| `LegacyIdempotencyMapping` | `targetEntityType`/`targetEntityId`/`sourceKey` 兼容映射 | 把旧 `clientId`/来源键指向已保留的目标 record UUID；状态必须是 `mapped`、`unknown` 或 `ambiguous` 等显式值，不冒充 receipt |
| `FamilySyncState` | 每家庭 feed `cursor` 分配行 | 为每个 family 建一行；`cursor` 只表示 feed 位置，起始值和 epoch 记录在 manifest；不存实体 version |
| `FamilyChange` | family 增量、upsert/tombstone、feed `cursor` + entity `version` | 初始导入不生成 change；baseline/epoch 只记录在 manifest/`SyncSnapshot`；未来先锁 `FamilySyncState`，每个实体独立递增 `version`，再分配一个 feed `cursor` |
| `UserSyncState` | user 维度同步游标 | 为 user 建一行；只承载 user-owned 数据，不把 family cursor 复制成全局序列 |
| `UserChange` | user scope 变更 | 只记录非敏感设备元数据、通知/家庭可见性状态和不含秘密的凭据状态事件；token、credential 原文及其 hash 永不进入任何 feed |
| `TaskExecution` | 通用持久任务执行头 | `kind/status/attempt/fence/lease/heartbeat/cancel/progress/result/lifecycle/nextEventSeq` 只存一份；覆盖 snapshot/export/delete/notification/AI |
| `TaskOutbox` | worker 可重试任务、lease、attempt | 保留 `phaseKey` 和 `dispatchState`（`active`/`parked`/`closed`）；`AiJob` 只迁历史；未完成 job 要显式转成 queued/review 状态并记录迁移原因；outbox 只触发 `TaskExecution` |
| `AiRun` | 持久 AI run 聚合上下文 | `AiJob` 可用同 ID 导入；只存 AI context/model/budget/message 关联，与 `TaskExecution` 一对一同主键，不重复 status/lease |
| `AiRunEvent` | 有序事件和重连游标 | 从可审计的历史结果生成事件；未知顺序不可臆造 |
| `AiToolExecution` | 工具调用、幂等和审计 | 旧 `toolsJson` 若能解析则拆解，否则保留 raw event |
| `Attachment` | 文件归属、hash、存储 key、状态 | 从 `AiArchive` 和业务图片路径建立；每个对象必须有 hash/size/归属 |
| `Notification` | 服务端通知、已读/撤销、稳定 ID | 当前页面的部分已读状态在浏览器本地，无可靠服务端行；不把本地状态冒充历史服务端数据 |
| `DeviceRegistration` | APNs/Web Push 设备注册和撤销 | 从 `PushSubscription` 映射 endpoint/keys；原数据字段不足时标记 legacy-web |
| `SyncSnapshot` | 一致快照、schema/cursor、恢复点 | 记录快照 manifest 和 cursor；关联一个 `TaskExecution`；不替代 `RecordSnapshot` 的业务撤销语义 |
| `TimelineEntry` | 事务维护的家庭时间轴投影和稳定 keyset | 源没有同构表；由业务写事务同步建立/更新/软删，不能迁移后用定时扫描猜补 |

`TaskExecution` 是所有后台任务的公共执行头，至少保留 `id`、`kind`、`status`、`attempt`、`fenceToken`、`leaseOwner`、`leaseExpiresAt`、`lastHeartbeatAt`、`cancelRequestedAt`、`progress`、`resultRef`、生命周期时间、`nextEventSeq`。`TaskOutbox` 只负责事务提交后的调度桥接，并保留 `phaseKey` 与 `dispatchState`（`active`/`parked`/`closed`）；进入 `awaiting_confirmation` 的 AI 任务必须释放 execution lease、保持 parked，不得被 dispatcher 重派，待明确确认后才以新 phase/attempt 重新领取。snapshot、export、delete、notification 和 AI 都关联同一个 `TaskExecution`。`AiRun` 与其同主键一对一，只存 AI context/model/budget/message 关联，不再复制 status、attempt、fence、lease、heartbeat、cancel、progress、result 或生命周期字段。迁移时必须先建立和验证通用任务执行头（对应 06 的 BE-08A），再回填 `SyncSnapshot` 或 AI 专属记录；不能为 AI、snapshot、通知各造一套 lease/状态机。

目标 schema 中，所有可同步的业务实体（包括各专属记录、`TimelineEntry`、`Attachment`、可同步配置）必须有对应 scope、独立递增的实体 `version`、`deletedAt`；family-owned 使用 `familyId`，私人 `Notification`、session、设备和凭据使用 `userId`。`FamilySyncState.cursor`/`UserSyncState.cursor` 是各自 feed 位置，`FamilyChange`/`UserChange` 同时携带 feed cursor 和该实体的 version，二者必须分开校验。静态 reference 表不加入家庭 feed。存量可同步 entity 的迁移基线固定为 `version=1`，`FamilySyncState.cursor=0`/`UserSyncState.cursor=0`，每个 state 的 `epoch` 使用本次 migration 新生成的 UUID 并写入 manifest；不为存量行伪造 change，客户端首次 bootstrap 后第一条真实写入才分配 cursor `1`。

### 3.2 family 变更的事务规则

所有可同步的写入都应在同一个 PostgreSQL transaction 内完成；涉及多个锁时统一按 `UserSyncState`（按 userId 排序）→ `FamilySyncState`（按 familyId 排序）→ `DeviceSession` → 凭据 → `TaskExecution` → entity 的顺序加锁，不涉及的 scope 可跳过。family-owned 路径在取得相关 `FamilySyncState` 锁后，必须在该锁持有期间重验 principal、membership/role、family/baby 归属和目标状态；不能先授权、再等待 state 锁、再沿用旧授权结论。随后检查实体当前 `version`/`baseVersion`，只递增被写实体的独立 `version`，写业务行（含 `familyId`、`version`、`deletedAt`），维护 `TimelineEntry`，在 state 锁下分配一个新的 `FamilySyncState.cursor`，写 `FamilyChange(familyId,cursor,entityType,entityId,version,...)`，最后写所需 `TaskOutbox`/`IdempotencyReceipt`。user-owned 的 session、设备和通知写入同理先锁定 `UserSyncState` 并重验 user scope，更新实体 version/deletedAt、分配 user feed cursor 并写 `UserChange`；不能把私人通知混进家庭 feed。事务提交后，客户端按 feed cursor 拉取，响应中的 entity version 只用于该实体冲突检测，绝不依赖 `updatedAt > lastSync`。

迁移回填时，legacy family/user row 按固定基线写 `version=1`、对应 state `cursor=0` 和新 `epoch`，`deletedAt` 保持 null；不生成 baseline `FamilyChange`/`UserChange`，客户端首次 bootstrap 后的第一条真实 change 才使用 cursor `1`。静态 reference 表不伪装成家庭同步表。之后每次业务写都必须产生唯一的 timeline/change 事实，不能让 projection、feed 和正文各自提交。

`FamilySyncState.cursor` 只保证同一 family feed 内按锁和提交顺序递增；`FamilyChange.version` 只描述对应实体的独立版本，两个不同实体的 version 不可互相排序。两个 family 的提交顺序、PostgreSQL sequence 值和 worker 处理顺序都不能作为跨租户排序依据。删除使用 tombstone，至少保留到所有受支持客户端的 cursor 过期并完成 compaction 证明。

权限以 repository 参数中的经过验证的 principal 和 family scope 为准；客户端传入的 `familyId`、`babyId`、`userId`、`runId`、附件 ID 只是检索键。涉及 baby 的新表建议使用 `(familyId,babyId)` 复合外键，避免一个 family 的 row 指向另一个 family 的 baby。

## 4. 跨 provider 的类型和兼容规则

### 4.1 ID、唯一键和 hash

| 数据 | 规则 |
|---|---|
| 所有旧实体 `id` | 目标优先使用 `text`，保留源字符串逐字值；不假设历史值都是 UUID。新实体由应用生成 UUIDv4 字符串。若未来某列必须收窄为 UUID，先做全量可解析性检查和兼容 mapping，非 UUID 行进入 quarantine，不能自动换新 UUID，否则旧客户端、附件 URL 和审计引用会断裂 |
| `username`、`clientId` | 保留值并在 staging 检查 Unicode、空格、大小写、重复；目标唯一索引建完后再放流量 |
| `inviteCode` | 源 plaintext 只可在受控只读提取中短暂使用；目标保存 `HMAC-SHA256(code, invitePepper)`、`keyId`、用途、有效/撤销时间和旧码映射，pepper 只在部署 secret 中；不把 plaintext 写入 target、manifest、日志或普通 staging |
| 静态业务 ID | `sourceId`、`vaccineId`、`strategyId`、`ruleId`、`milestoneId`、`warningSignId`、`foodId`、`bookId`、`activityId` 全部保留，作为外部稳定标识 |
| 密码/PAT/refresh hash | `passwordHash`、`PersonalAccessToken.tokenHash`、`OAuthRefreshToken.tokenHash` 视为不透明值，保留字节/大小写；只验证格式和唯一性，不重新 hash、不输出、不还原明文 |
| `AiArchive.contentHash` | 作为内容证明保留；迁移前后对同一内容重新算 SHA-256 比对。hash 不等于文件迁移成功，仍要比对 byteSize 和对象内容 |
| client idempotency | 只有 v1 明确的 `Idempotency-Key` 且能还原 actor、scope、canonical body hash、result reference 的请求才写 `IdempotencyReceipt`；旧 `clientId` 若缺 actor/body hash，写 `LegacyIdempotencyMapping(targetEntityType,targetEntityId,sourceKey,status)` 指向保留的记录 UUID，不伪造可成功 replay 的 receipt。映射状态 `mapped`/`unknown`/`ambiguous` 必须显式；目标重复保护依靠 record UUID 和 mapping 唯一性 |
| `OAuthAuthorizationCode.code` / `clientSecret` / Push keys | 仅在受控 secret channel 处理；默认清理过期 code、重新签发/轮换 secret。manifest 只写 hash、ID、状态，不写秘密值 |

旧 token 不能按“有一行就导入并立即生效”处理。DB00 必须为每个凭据输出 `preserved`、`preserved_then_rotate`、`revoked`、`reauthorize` 或 `redacted` 状态及原因；manifest 只含来源 ID、目标 ID、哈希、过期/撤销状态和 policy version：

| 源凭据 | 默认决策 | 允许保留的条件 | 不满足条件的动作 |
|---|---|---|---|
| `OAuthRefreshToken` | `preserved_then_rotate` | hash 完整；未过期/未撤销；client 存在；resource/audience/scope 通过新 OAuth policy；仍留在 OAuth 专属命名空间 | 标记 revoked + reason，要求重新授权；不把 hash 当成首方 `RefreshCredential` 或 v1 access 的可用证明 |
| `OAuthAuthorizationCode` | `reauthorize` | 默认没有例外；一次性 code 与切换窗口天然有 race | 在写栅栏前让 pending code 失效，外部 client 重新走 PKCE；过期 code 只记统计 |
| `PersonalAccessToken` | `preserved` 或 `preserved_then_rotate` | hash、用户归属、创建/撤销状态和 scope 可验证，目标 endpoint contract 兼容 | 立即 revoke 并通知用户重新创建；不恢复明文 |
| `OAuthClient.clientSecret` | `preserved_then_rotate` | secret 形状/归属和新 OAuth adapter 兼容；值只在 secret channel 使用 | 轮换并令旧 secret 失效；manifest 不写值 |
| `User.passwordHash` | `preserved` | 这是登录 verifier，不是 access token；hash 格式可被当前认证层验证 | 不删除账号；要求受控密码重置或升级 hash，绝不要求读取明文 |
| `PushSubscription.keysJson` / 设备 token | `preserved`（标记 legacy） | endpoint/token 完整、环境明确、用户仍有归属 | 注销旧 registration，客户端重新注册；不在日志中显示 keys |

首次成功 refresh/使用时如何旋转旧凭据要有可审计结果；旋转失败不能把原凭据悄悄标为已消费。cutover 后 token 保留比例、撤销比例、重新授权比例必须逐类核对。

首方 `DeviceSession`/`RefreshCredential` 与外部 `OAuthClient`/`OAuthAuthorizationCode`/`OAuthRefreshToken`/`OAuthConsent` 是两个凭据命名空间。源 OAuth refresh token 的保留或旋转只改变 OAuth 表内状态，不能填充首方 refresh credential；首方会话在切换后重新签发，除非另有独立、可审计的首方凭据来源。旧邀请码的兼容路径只比较输入 code 的 HMAC：目标以 `HMAC-SHA256(code, invitePepper)` + `keyId` 建唯一索引，pepper 只来自部署 secret；新码使用 32 个随机字节的 base64url 表示。仍可用的旧 6 位码仅在有限兼容期限内通过 `LegacyInviteCodeMapping`（目标 hash、keyId、用途、过期/撤销状态）验证，并对尝试限流；使用后立即按新码 hash 轮换。过期、撤销或无法证明归属的 code 显式拒绝，不保留 plaintext。

### 4.2 字符串日期、时刻和时区

目标使用 `timestamptz(3)` 表示实际瞬间，使用 `date` 表示无时区日历日期，使用 `time without time zone` 表示家庭本地墙上时间。所有 instant 输入必须带明确 offset 或已知家庭时区；没有 offset 的字符串不得猜成 UTC。

| 源字段 | 目标类型 | 转换和失败规则 |
|---|---|---|
| `FeedingRecord.timestamp`、`DiaperRecord.timestamp` | `timestamptz(3)` | 解析 ISO-8601；保留毫秒精度。非法、缺 offset 或超出范围进入 quarantine |
| `SleepRecord.startTime` / `endTime` | `timestamptz(3)` | 两端都解析；end < start、空字符串或无时区时停止该行，不做静默修正 |
| 所有现有 `createdAt`、`updatedAt`、`expiresAt`、`finishedAt`、`restoredAt`、`lastUsedAt` | `timestamptz(3)` | SQLite/Prisma 读出的时间按 UTC 语义转入；记录原值和归一化值供差异报告 |
| `Baby.birthDate`、`GrowthMeasurement.date`、`MedicalReport.date` | `date` | 只接受 `YYYY-MM-DD`；生日不是午夜 instant |
| `SupplementSchedule.startDate`、`FamilyFoodStatus.firstAddedDate` | `date` | 空值继续为空；非法值 quarantine |
| `SupplementRecord.date` / `time`、`FoodLogRecord.date` / `time` | `date` + `time without time zone` | 保留家庭当地录入语义；不凭空生成 UTC eventAt |
| `SupplementSchedule.reminderTime` | `time without time zone` | 校验 `HH:mm[:ss]`，结合家庭时区由提醒服务解释 |
| `DataRelease.asOf`、`SourceRef.publicationDate` / `accessedDate`、`Vaccine.policyEffectiveDate`、`Book.ratingRetrievedDate` | `date` | 纯资料日期，不转 timestamptz |
| `VaccineRecord.scheduledDate` / `completedDate`、`FoodPlan.date` | `date` | 预约/完成日和计划日无时刻；原空值保持空 |
| JSONB 内嵌 `effectiveDate` 等日期 | JSONB 内的 canonical string | 先解析并验证；不在没有 JSON schema 的情况下递归猜测并改语义 |

时间转换必须保存 `source_value`、`normalized_value`、`timezone_assumption`（应为 `explicit` 或 `quarantine`）的统计，不把系统本地时区作为隐式规则。

### 4.3 JSON、原始文本和 hash

已在 schema 注释为数组、对象或 JSON map 的字段，目标首选 `jsonb`，但迁移顺序是：原字符串取出 → JSON parser 严格解析 → 校验预期顶层类型 → 写 JSONB → 用 canonical JSON/hash 做语义对账。解析失败不能写成 `null` 或空数组。

主要 JSONB 字段包括：

- 营养/记录：`FormulaProduct.nutrientsJson`、`SupplementProduct.nutrientsJson`、`SupplementSchedule.customDaysJson`、`MedicalReport.itemsJson`、`FoodLogRecord.foods`、`FoodPlan.tags`/`ingredients`/`steps`。
- 疫苗/规则：`Vaccine.diseases`/`catchUpRules`/`substitutionRules`/`contraindications`/`precautions`/`specialPopulations`/`regionalOverrides`/`regimenOptions`/`sourceRefsJson`，以及 `VaccineDose.sourceRefsJson`、`VaccineStrategyGroup.optionsJson`/`sourceRefsJson`、`VaccineScheduleEntry.sourceRefsJson`、`ScheduleEngineRule.vaccineIdsJson`/`sourceRefsJson`。
- 知识库：`DevelopmentMilestone.sourceRefsJson`、`DevelopmentWarningSign.sourceRefsJson`、`FeedingGuideline.*Json`、`FoodItem.*Json`、`Book.*Json`、`ActivityRecommendation.*Json`。
- 协议/审计：`PushSubscription.keysJson`、`OAuthClient.redirectUrisJson`/`grantTypesJson`/`responseTypesJson`、`AiChatMessage.toolsJson`、`OAuthAuditLog.metadataJson`。

以下数据默认保留原始 text，并可附带解析后的 JSONB 派生列，防止审计内容因 JSONB 重排而失去字节证明：`AiArchive.content`、`AiJob.resultJson`、`RecordSnapshot.payloadJson`。`resultJson`/`toolsJson` 若解析失败仍保留 raw，事件状态标记 `unparsed`，由后续人工或版本化 parser 处理。`nutrition`、备注、医生笔记、提示词、回复等业务文本不要为了“统一”强行转 JSON。

### 4.4 Float、Decimal、布尔和枚举

SQLite `REAL` 对应的业务测量/剂量目标不继续用二进制浮点作为持久精度。建议第一版 PostgreSQL 使用 `numeric`，具体 precision/scale 只能在真实值分布审计后定稿；对外 HTTP/Swift 合同统一发送十进制字符串，Swift 端解析为 `Decimal`，不能让 JavaScript `number` 或 Swift `Double` 在 wire 上丢精度：

| 源 Float | 初始建议 | 备注 |
|---|---|---|
| `GrowthMeasurement.weightKg` | `numeric(10,3)` | 先统计小数位；API DTO 可转 number/string，但数据库不做隐式二进制舍入 |
| `heightCm` / `headCircumferenceCm` | `numeric(10,2)` | 迁移前检查最大值、负数和精度 |
| `FormulaProduct.scoopWeightG` / `waterPerScoopMl` / `reconstitutionRatio` | `numeric(12,5)` 或经样本确认的 scale | 不能在未看数据分布前承诺精度 |
| `SupplementProduct.defaultDose`、`SupplementSchedule.targetDose`、`SupplementRecord.dose` | `numeric(12,3)` | 保留单位字段；数字本身不能解释单位 |
| `VaccineDose.doseVolumeMl` | `numeric(10,3)` | 过大的值进入校验报告 |
| `Book.ratingScore` | `numeric(4,2)` | 允许 null；范围约束在数据审计后落地 |

迁移脚本先将 SQLite 值格式化为 decimal string，验证可解析、范围和 scale，再写 numeric。任何会改变原始数值的舍入都必须在 mapping contract 中有版本和计数；不能直接 `CAST(real AS numeric)` 后宣称精确。

金额/测量/营养字段的 DTO 例为 `"120.000"` 而非 `120`；显示层可格式化，业务比较使用 parser 后的 Decimal。旧值需要保留旧语义时，mapping manifest 同时保存 source lexical value、target numeric value 和 rounding policy。

当前 model 没有 Prisma `enum`，而是多个 String + default。目标长期使用 PostgreSQL `text` + `CHECK`/参考表，并以 TypeScript/Swift string union 表达协议；不预留后续 Prisma enum 迁移。约束可先以 `NOT VALID` 加入，清理未知值后再 `VALIDATE CONSTRAINT`。候选值包括 `FamilyMember.role`、`relation`、`Baby.gender`、记录 type/source、补剂 frequency、产品 dosage/serving unit、AI status、审计 authResult/action、疫苗 priority/category 等。任何未知值不能静默变成 `other`，必须进入 quarantine 报告并经明确决策处理。

## 5. 快照、WAL 和源数据安全

### 5.1 快照原则

SQLite 源正在使用 WAL 语义时，主库文件、`-wal` 和 `-shm` 不能通过普通文件复制拼接。计划使用只读连接的 SQLite online backup API（当前 `scripts/backup-db.sh` 已采用 Python `src.backup(dst)` 思路）取得一个一致快照。只读连接不应使用 `immutable=1` 读取仍可能有 WAL 的源，因为这会忽略 WAL 内容。

快照脚本必须：

1. 接受经过人工确认的绝对源路径；默认拒绝空路径、`dev.db`/`prod.db` 以外的未声明路径和工作目录内任意 glob。
2. 以 `mode=ro` 打开源，不能在源上执行写入、`VACUUM`、`wal_checkpoint(TRUNCATE)` 或清理操作。online backup 期间监控 WAL 增长和目标磁盘，不为“加快”而强制 checkpoint。
3. 输出独立快照数据库、schema/migration manifest、源 DB/WAL 状态、每表 row count、最小/最大时间、源 snapshot marker 和 SHA-256；产物权限 600，路径不进入 Git。
4. 对快照执行 `PRAGMA integrity_check`/`quick_check`、外键检查和 `_prisma_migrations` 状态检查；源快照失败即停止 ETL。
5. 附件单独建立对象清单和 hash；数据库快照成功不等于 `public/uploads` 或 `data/archive` 已备份。

### 5.2 不一致条件

以下任一情况必须丢弃该快照并重新取得：源数据库在 backup 过程中发生异常、WAL 读取不完整、快照 hash 在校验时变化、integrity check 非 `ok`、表 count 与 snapshot manifest 不一致、附件读取权限/文件内容变化、无法标出 snapshot time/marker。不得拿“差不多同时导出的两个目录”拼成迁移源。

### 5.3 规划命令和产物

```text
【拟新增未存在】npm run backend:migration:rehearse -- \
  --manifest /受控目录/migration-<run-id>.manifest.json \
  --phase snapshot

产物：snapshot.db、manifest.json、每表计数/时间摘要、源 schema hash、源 migration lock 摘要、
      SQLite integrity/foreign-key 报告；当前没有此根命令，也不应读取真实生产库。
```

## 6. ETL 拓扑与不丢写策略

### 6.1 拓扑

```text
只读 SQLite online snapshot + 附件 inventory
                 │
                 ▼
        本地/隔离 staging（原值、解析值、row hash、quarantine）
                 │  FK/JSON/date/decimal/attachment 对账
                 ▼
       PostgreSQL 18 migration target（独立 DB/role）
          │                    │
          │ shadow read        │ future writes
          ▼                    ▼
       读模型比较器       FamilySyncState 行锁 + change + outbox
                 │
                 └── unified write fence / final snapshot / checkpoint / cutover
```

staging 必须保留 `source_model`、`source_id`、`source_row_hash`、`raw_payload`、`normalized_payload`、`mapping_version`、`status`、`error_code`。staging 可使用独立 database/schema，不得与生产 schema 混用；原始敏感字段需访问控制和到期清理策略。

### 6.2 ETL 阶段

**阶段 A：只读盘点和映射冻结。** 生成 47 model 的字段 registry、日期/JSON/decimal parser 版本、ID mapping、附件规则和敏感字段清单。没有 registry 版本，不准建目标 baseline。

**阶段 B：目标 schema 与空库验证。** 创建 PostgreSQL 18 的隔离 database 和最小角色；先应用新 schema migrations，再运行 Prisma 7 generate/validate 和纯 SQL constraint 检查。此阶段不导入生产数据。

**阶段 C：快照 bulk load。** 以依赖顺序导入：身份/静态 reference → family/baby/members → family config → 业务记录 → AI/chat/OAuth/audit → attachment metadata。每批使用 keyset pagination 和可重试 batch manifest；不按 offset 在源上长时间扫描。

**阶段 D：解析、约束和附件对账。** 每批先进入 staging，再 upsert 到 target；完成 count、ID/hash、FK、JSON、时间、numeric、family boundary 和对象 hash 对账。任何 quarantine 行按模型和错误码计数，不能以“忽略坏行”结束阶段。

**阶段 E：通用任务执行头先行。** 在 snapshot、export、delete、notification 或 AI 回填前，先验证 `TaskExecution`/`TaskOutbox` 的持久状态、lease、fence、heartbeat、取消和结果引用；任务状态只存公共执行头，`AiRun` 仅保留 AI 上下文。此阶段对应 06 的 BE-08A，早于同步 snapshot（BE-06）和 AI/SSE（BE-08B）。

**阶段 F：shadow read 和双读比较。** 对脱敏的测试请求或受控 read-only 请求同时读源和目标，比较 canonical DTO、总数、实体 version、feed cursor、删除语义和附件可读性。目标查询必须经过 principal scope；比较器不能用目标结果反向修改源。

**阶段 G：统一停写、最终全量快照和 checkpoint。** 先让 router/API 获得写栅栏，停止接受新的源业务写入；排空栅栏前已经接受的请求，客户端收到可重试维护响应并保留本地未提交 outbox。栅栏持有期间用 SQLite read-only online backup API 重新取得最终全量 WAL 一致快照，完成整库 ETL、附件导入和全量 row/hash/FK/权限/任务对账。checkpoint 审计必须记录不可变 fence marker、最终 snapshot marker/hash、每表计数、附件 manifest hash、目标 migration revision、baseline cursor/entity-version 范围、quarantine 决策和“栅栏后无源新写”证明；不要求也不假设源 journal/CDC。

**阶段 H：目标切换和稳定期。** 只有最终快照与 checkpoint 全部通过后才把 router/API 指向 PostgreSQL；释放栅栏前先做新 API principal、family/user cursor、任务执行头和旧客户端重试冒烟。切换后新写只进 PostgreSQL，由业务事务、`FamilyChange`/`UserChange`、`IdempotencyReceipt` 和 `TaskOutbox` 形成证据；保留最终源快照和附件 manifest 作为审计恢复点，不把逆向 replay 作为默认能力。

### 6.3 停写与回退

切换成功的必要条件是：最终只读快照全部导入；checkpoint 中的 snapshot/hash/count/FK/tenant/附件/任务对账全部通过；每个可恢复 receipt 的请求 hash 与结果一致，legacy mapping 的 `unknown`/`ambiguous` 已显式处理；实体 version 与 feed cursor 分开且连续性规则通过；新 API 的 principal/family/user cursor 冒烟通过；所有后台任务都有 `TaskExecution` 状态和 fence；最后才释放写栅栏。源 journal/CDC 不在首发验收条件内。

在最终栅栏或目标验证前失败：保持 SQLite 为 primary，保留失败报告、staging 和最终快照，修复后从最后一个完整快照重新演练；不能把半成品目标当成回退点。因为栅栏阻止了新的源写入，不需要逆向回放来恢复源。

切换后若确认 PostgreSQL 尚未接受任何新写（只发生路由/读取或目标验证失败），可依据 checkpoint 直接把 router 切回最后一致的 SQLite 快照/源库，并重新进行全量切换。此条件必须由目标提交审计和 router 日志共同证明，不能靠人工猜测。

切换后只要 PostgreSQL 已接受过任意新写，就保持 PostgreSQL 为 primary；停止有问题的入口，使用应用回滚或 forward fix、补偿命令和新的 migration/对账修复。不得默认把 `FamilyChange`/`UserChange` 逆向重放回 SQLite，也不得在未证明所有新写可表达且不重复的情况下直接降级。不可修复的数据差异进入人工审计和停止放量流程。

## 7. 附件和归档对账

当前可见的附件来源至少包括：`Baby.avatarUrl`、`GrowthMeasurement.imageUrl`、`MedicalReport.imageUrl`、`AiJob.imageUrl`、`/uploads/avatars`、`/uploads/medical`、`/uploads/growth`、`/uploads/nutrition`，以及 `AiArchive.filePath` 指向的 `data/archive/YYYYMM/`。代码审查还记录过 public upload、路径访问和归属校验边界；因此附件迁移不能仅把 URL 字符串复制到 PostgreSQL。

附件 inventory 每行至少记录：source path/URL、source model+row+field、familyId/babyId/userId（能推导则填，不能推导则 quarantine）、size、MIME、扩展名、SHA-256、mtime、存储区域、是否被多个记录引用、是否为 symlink、目标 storage key、迁移状态。路径必须按允许根目录解析并拒绝 `..`、符号链接逃逸和 public 直链。

建议的映射：有 `AiArchive.id` 的对象保留原 `id` 作为 `Attachment.id` 或 `legacyArchiveId`，保留 `contentHash`、byteSize、kind、legacy path；只有 URL/path 没有归档行的文件才分配新的稳定 attachment ID，并在 mapping 表保留原路径。相同内容 hash 可以共享底层 blob，但每个业务引用仍要有独立授权关系或明确的共享规则。`RecordSnapshot` 的 payload 中旧路径也要进入引用扫描，不能只扫当前业务表。

附件验收必须同时通过：数据库引用数与 inventory 引用数一致；每个非空对象实际存在；迁移前后 SHA-256 和 byteSize 一致；MIME/扩展名与允许列表一致；family/baby 授权测试通过；孤儿文件、缺失文件、重复 hash、损坏文件、无法归属文件各有清单和处理决定。hash 相同只能证明内容相同，不能证明访问权限正确。

## 8. 验证清单

每次迁移批次都输出机器可读报告和人工可读摘要。报告按 `mapping_version`、source snapshot marker、target migration revision、batch ID 固定。

### 8.1 结构和完整性

- 目标所有预期表、列类型、默认值、唯一键、索引、FK、`on delete` 行为与 schema contract 一致。
- 目标 PostgreSQL `current_database()`、`current_user`、server major version 为批准值；测试/ staging role 无生产 database CONNECT 权限。
- 依赖顺序正确：成员、宝宝和静态引用存在后才能建立业务 FK；任何孤儿 FK 为 0。
- family-owned 表每行都有正确 `familyId`、合法 `version`；baby/product 等跨家庭组合为 0。
- 每个可同步实体都有 scope、独立 `version`、`deletedAt`；`TimelineEntry` 与源业务行一一对应且稳定 keyset 不重复；只有 `Notification` 和非敏感设备元数据可出现在 `UserChange`，凭据自身、token、credential 原文及其 hash 永不进入任何 feed（凭据状态只能以不含秘密的事件表达）。
- `deletedAt` tombstone 和 `FamilyChange` 的 delete event 一一对应；不能以物理删除替代同步删除。`FamilySyncState.cursor`/`UserSyncState.cursor` 只作为 feed position，不能被当作 entity version。

### 8.2 行、ID、hash 和数值

- 每个 47 model 的 source/target count、null count、unique count、分批 count 相等，允许差异只能来自列在 quarantine manifest 中的行。
- 所有主键、业务唯一键、token/content/password hash 的保留率和 hash 比对通过；冲突为 0。
- Decimal 目标值与明确的 rounding policy 相符；溢出、负值、异常 scale 有单独报告。
- Boolean/null/default 不因 SQLite truthy 字符串或缺省值被改变；`false`、`null`、缺列必须分别统计。

### 8.3 日期和 JSON

- instant 解析成功率 100%（quarantine 行除外且有业务处理），offset/时区假设可追溯；睡眠区间和日期范围合理。
- date-only 字段仍是同一天；没有把生日、预约日、家庭 local log 变成 UTC 前一天/后一天。
- 每个 JSON 字段顶层类型正确；source canonical hash 与 target JSONB canonical hash 一致。raw text 保留字段的字节 hash 一致。
- 未知枚举值、空字符串、`NaN`/`Infinity`、尾随垃圾 JSON 均不得静默降级。

### 8.4 行为、租户和任务

- principal 只能访问成员所属 family；同 ID 跨 family 查询返回 404/403 的既定协议；移除成员后旧凭据不能读新数据。
- 相同 v1 idempotency key + 相同 payload 只产生一个业务 row/receipt；相同 key + 不同 payload 必须 conflict。无法还原 actor/body hash 的旧 `clientId` 只能进入 `LegacyIdempotencyMapping`，不得被当作成功 replay receipt；保留 record UUID 防止 ETL 重复，`unknown`/`ambiguous` 必须在报告中显式处理。
- 目标变更以 family cursor 可重复拉取，删除可见，cursor 过期能由 snapshot 重建；`FamilySyncState` 行锁并发测试无重复/倒退 cursor，各实体 version 独立单调；锁后授权重验与写入在同一事务内完成。
- timeline 首次导入、更新、删除与业务事务结果一致；按 `(occurredAt,id)` keyset 翻页不会漏行或重复；通知已读/撤销以 user cursor 在多设备收敛。
- `TaskOutbox` lease 过期可重领，重复 worker 不产生重复 AI tool write；AI 最终结果先入库再通知。
- active 首方 refresh credential 的 audience/resource/scope 与新 API 合同一致；失效 code 不可兑换；OAuth refresh token 只按 OAuth 专属命名空间验证，不能作为首方 `RefreshCredential`；旧 OAuth/MCP 客户端不会越过 principal scope。
- `TaskExecution` 作为 snapshot/export/delete/notification/AI 的唯一公共状态头，任务 lease/fence/heartbeat/cancel/result 的原子提交和旧 fence 拒写通过；`AiRun` 不重复存公共状态。

### 8.5 迁移后读写比较

- Web 兼容 API、iOS v1 API、MCP 适配层对同一 fixture 返回相同业务语义；兼容旧客户端的字段/错误码有契约测试。
- 关键路径：登录/刷新、家庭成员、宝宝切换、喂养、睡眠、尿布、成长、医疗报告、疫苗、补剂、AI run、附件上传/下载、通知注册。
- 以上检查全部通过后才允许逐步放量；“目标能连接”“Prisma migrate 成功”不等于数据迁移验收通过。

## 9. 测试数据库和安全隔离迁移

当前规范继续生效，直到新的 PostgreSQL 隔离 runner 通过验收：

```text
npm test
npm run test:unit
npm run test:ai
npm run test:api:server
bash scripts/test-api.sh 3089
```

这些现有命令仍使用 `.env.test`、`dev_test.db`、端口 3089、`test_`/`e2e_` 用户/家庭/宝宝和现有 purge 规则。不得在新 backend 尚未通过隔离验证时修改它们去连接 PostgreSQL，更不得以测试 convenience 使用 `prod.db`、`dev.db` 或真实家庭。

未来 PostgreSQL runner 的建议：

1. 为 `test`、`staging`、`prod` 使用物理分离 database，至少为测试使用独立 database 和独立 role；测试 role 没有生产 database 的 CONNECT/USAGE 权限。
2. runner 在启动时查询并断言 `current_database()`、`current_user`、主机 allowlist、`APP_ENV=test` 和目标 schema revision；任一不符合即熔断。`lib/prisma.ts` 的 SQLite 文件判断要改成同时拒绝生产 database 名、生产 role、生产 host 和缺少 test 标志的 URL。
3. PostgreSQL test database 从 `prisma/migrations` 重建，使用独立 seed 和事务/tenant cleanup；所有实体仍遵循 `test_`/`e2e_` 前缀。测试报告不得输出连接串、token、密码 hash、Push keys 或医疗正文。
4. 先运行少量 unit/domain tests，再跑 API isolation、并发 cursor、worker lease、附件 hash、跨租户拒绝和回滚演练；重复运行两次且无残留，才考虑将现有 API/E2E runner 从 SQLite 切到 PG。
5. 新 runner 通过前，旧 SQLite 测试规范和安全 guard 是唯一有效规范；不接受“PG runner 大致能连”作为替代证明。

## 10. DB00–DB16 实施任务手册

以下每一步都必须保留输入、产物和验收记录。命令均标记为 `【拟新增未存在】`，并统一使用 06 的根 `npm run backend:*` 接口；当前部分名称已有声明但尚未验收，本次整理不执行。每一步失败都必须停在该阶段，不跳到 cutover。任务初始状态全部为 `NOT_STARTED`；实现者只能报告 `IMPLEMENTED_NOT_REVIEWED` 或 `BLOCKED`，只有独立 review 才能改为 `ACCEPTED`。DB09 内先建立通用 `TaskExecution`，再处理 `SyncSnapshot`/AI 关联；对应 06 的 BE-08A 先于 BE-06 与 BE-08B。

| 编号 | 状态 | 输入、【拟新增未存在】根命令与产物 | 验收 | 失败处理 | 性能索引建议（需真实数据 `EXPLAIN` 验证） |
|---|---|---|---|---|---|
| **DB00 源盘点冻结** | `NOT_STARTED` | 输入：`schema.prisma`、6 条 SQLite migrations、seed/reference 文件、现有附件根目录。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase inventory`。产物：覆盖 47/47 model 的完整 migration manifest、字段类型表、ID/hash 保留表、敏感字段表、OAuth/首方 token 分离决策表、`LegacyIdempotencyMapping`/邀请码 hash 规则、migration history 摘要、附件根目录清单。 | manifest 覆盖 47/47 model、每列有 mapping、每个凭据有 policy version 和状态；不读秘密、不连生产；`clientId` 无法还原时不会生成 receipt。 | 补 manifest/凭据策略；无法判断的字段标 `needs-decision`，禁止开始建表；不得以“先导入再说”替代 token/idempotency/invite 决策。 | 记录现有索引作为 baseline；不因未有 cardinality 而添加索引。 |
| **DB01 映射合同** | `NOT_STARTED` | 输入：DB00 registry、API/domain 类型、日期/JSON/decimal 规则。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase contract`。产物：版本化 mapping contract、quarantine code 表、canonical JSON/decimal parser 版本、entity version/cursor 和 TaskExecution 字段合同。 | 每个字段有 source/target/null/default/transform/retention；ID/hash、OAuth namespace、旧 code hash、legacy mapping 状态清晰。 | 把字段留在 text/raw，或补业务决策；不得临时在 ETL 中猜类型。 | 在 contract 中列访问谓词，作为后续索引输入；不提前承诺性能。 |
| **DB02 PG18 隔离环境** | `NOT_STARTED` | 输入：批准的 PostgreSQL 18 测试资源信息（未来由持有人提供）。命令：`【拟新增未存在】npm run backend:doctor`、`【拟新增未存在】npm run backend:deps:test`、`【拟新增未存在】npm run backend:test:guard`。产物：数据库/role/host 权限审计、连接 allowlist/deny 报告、隔离依赖版本。 | test/staging/prod 物理边界和 role deny 通过；迁移 role 与运行 role 分离；guard 在连接业务前拒绝生产和旧 `file:` 数据库。 | 不创建或不调整权限以“先试试看”；停止，重新申请隔离资源。 | 初始只建主键/唯一键；后续按查询计划建复合索引。 |
| **DB03 目标 Prisma 配置** | `NOT_STARTED` | 输入：DB02 隔离 URL、Prisma 7 `prisma-database-setup` skill 约束。命令：`【拟新增未存在】npm run backend:db:validate`、`【拟新增未存在】npm run backend:typecheck`。产物：`prisma/schema.prisma`、`prisma.config.ts`、generated client、adapter/bootstrap 验证记录。 | provider 是 `postgresql`；URL 只在 config；runtime 用 `@prisma/adapter-pg`/`pg`；单 client/pool；无空构造/`datasourceUrl`；`SELECT 1`、事务回滚和 shutdown ownership 只验证一次，不能双 end。 | 删除错误 provider/config 后重做；不把根 Web `lib/prisma.ts` 临时改成半成品；adapter 生命周期不明确时标 `BLOCKED`。 | 只验证 schema；索引在 DB04/DB11 基于计划验证。 |
| **DB04 独立 migration baseline** | `NOT_STARTED` | 输入：DB01 contract、目标 schema、PostgreSQL 18 空库。命令：`【拟新增未存在】npm run backend:db:test:migrate -- --manifest <path>`。产物：独立 PG migration lock、baseline SQL、空库/升级样本审阅 diff。 | SQL 无 `PRAGMA`/SQLite rebuild；空库可重复部署；provider history 与旧 SQLite 完全分离；TaskExecution 等公共表先于其关联实体建表。 | 删除错误 baseline 并重生成；不得复制旧 `migration.sql` 或改旧 lock 冒充目标历史。 | FK/unique 先行；大索引或 partial index 另以受控、可回滚 SQL 建。 |
| **DB05 只读一致快照** | `NOT_STARTED` | 输入：批准的源绝对路径、DB00 manifest。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase snapshot`。产物：snapshot DB、WAL 状态、integrity/FK 报告、源 hash、snapshot marker；不包含 secret。 | 只读 online backup 成功；不执行 checkpoint/write；manifest 可重算；最终切换可再次取得全量快照。 | 丢弃快照，等待 WAL/磁盘稳定后重取；不使用 `cp` 拼主库与 WAL。 | 源查询使用已有索引/主键；快照阶段不新增源索引或运行 VACUUM。 |
| **DB06 staging 与 row hash** | `NOT_STARTED` | 输入：DB05 snapshot、DB01 parser。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase staging`。产物：staging 表/分片、raw/normalized payload、row hash、quarantine、legacy source mapping。 | 批次可重试且不重复；每行有 source key、mapping version、状态；raw secret 有访问/清理边界。 | 只重跑失败 batch；先修 parser/contract，不手改目标行。 | staging 按 `(source_model,source_id)`、`status` 建索引；导入后可移除临时索引。 |
| **DB07 身份与静态数据** | `NOT_STARTED` | 输入：staging 的 User/Family/FamilyMember/Baby、reference rows。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase identities`。产物：身份/家庭/静态表、ID mapping、邀请码 hash mapping、唯一键报告。 | 47 model 的 ID 稳定；reference FK 可解析；password/token hash 未曝光；旧邀请码仅 hash 验证，plaintext 不进目标。 | 按冲突类型 quarantine；不同意改 ID 时停止，不用新 UUID 覆盖旧引用；旧码状态不清晰时禁止放流量。 | `FamilyMember(familyId,userId)`、`Baby(familyId,id)`、静态业务 ID unique；以实际计划修正。 |
| **DB08 业务 bulk ETL** | `NOT_STARTED` | 输入：DB07 依赖、业务 staging。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase domain-etl`。产物：13 条记录/配置模型、批次 checkpoint、date/JSON/decimal 报告、`TimelineEntry` baseline projection、实体 version 基线。 | count、ID、FK、日期、JSONB、numeric、family boundary 和 timeline stable key 通过；每个实体 version 可解释且不等于 feed cursor。 | 失败批次回滚到 batch boundary；坏行进入 quarantine，不跳过整表并宣称成功；timeline 不完整时不进入 shadow。 | 记录表建议 `(babyId,occurredAt DESC,id)`、`TimelineEntry(babyId,occurredAt DESC,id)`、实体 `(familyId,version)`；软删查询用 partial index。 |
| **DB09 通用任务与同步实体回填** | `NOT_STARTED` | 输入：DB07/08 行、目标新增实体清单。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase sync-tasks`。产物：先有 `TaskExecution`/`TaskOutbox`，再有 `FamilySyncState`/`UserSyncState`、epoch/`SyncSnapshot` 基线（不生成 baseline change）、`LegacyIdempotencyMapping`、仅完整证据的 receipt、`RecoveryCode`、`AiRun`/事件、私人 `Notification`/`UserChange` 报告；`SyncSnapshot`/export/delete/notification 都有 task 关联。 | `FamilyChange`/`UserChange` 的 cursor 与实体 version 分开；state row 锁并发无重复 cursor；旧 `AiJob` 有明确状态但不宣称可恢复；`AiRun` 不重复公共任务状态；`TaskOutbox.phaseKey/dispatchState` 正确，`awaiting_confirmation` 释放 lease 且不重派；通知不出 family feed；UserChange 无 token/credential 原文或 hash；恢复码只 hash 存储且与 password/session 事务一致。 | 暂停客户端同步，修正映射；无法判断的旧 task/通知标记 review，不自动执行、补发或生成 replay receipt。 | `FamilyChange(familyId,cursor)`、`UserChange(userId,cursor)`、实体 `(familyId,id)` 条件version更新、`TaskOutbox(dispatchState,phaseKey,nextDispatchAt)`、`TaskExecution(status,leaseExpiresAt)`、`Notification(userId,version,deletedAt)`。 |
| **DB10 附件 inventory 与导入** | `NOT_STARTED` | 输入：DB05 snapshot、上传目录、`AiArchive.filePath`、所有 image URL/payload 引用。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase attachments`。产物：attachment map、object hash、孤儿/缺失/重复报告、访问归属报告、`TaskExecution` 结果引用（若异步）。 | 每个引用对象存在、hash/size 相等、family/baby ACL 通过；所有异常有决定。 | 不导入缺 hash/归属不明对象；保留源文件和 quarantine，修复后重跑。 | `Attachment(familyId,babyId,contentHash)`、引用表按 owner/family 建；大文件不在 DB 复制。 |
| **DB11 对账和约束验证** | `NOT_STARTED` | 输入：所有 ETL 产物。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase verify`、`【拟新增未存在】npm run backend:evidence:check -- --task DB11`。产物：count/hash/null/FK/date/json/decimal/cursor/entity-version/timeline/user-notification/task/附件综合报告。 | 零未解释差异；quarantine 有总数、原因、负责人和后续决策；性能仅记录计划，不作承诺；checkpoint 可签名审计。 | 阻断 shadow/cutover；修 parser、数据或 schema 后从 staging 重跑。 | 用 `EXPLAIN (ANALYZE, BUFFERS)` 仅在隔离 PG 代表数据上决定索引；不要凭 intuition 加几十个索引。 |
| **DB12 最终停写与 checkpoint** | `NOT_STARTED` | 输入：DB11 clean report、已批准写栅栏、最终全量 snapshot/附件 manifest。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase cutover-checkpoint`。产物：不可变 fence marker、最终 snapshot/hash/count、附件 manifest hash、target revision、baseline cursor/entity-version 范围、无栅栏后源新写证明。 | 栅栏获得后不再接受源新写；已接受请求已排空；最终 snapshot 是 WAL 一致全量；checkpoint 通过，不依赖 source journal/CDC。 | 保持 SQLite primary，释放不了的栅栏不进入切换；丢弃不一致快照并重取，不以“补一条 journal”绕过。 | checkpoint marker 建唯一约束；高写流量期间不临时创建阻塞性全表索引。 |
| **DB13 shadow read** | `NOT_STARTED` | 输入：DB11 报告、DB12 之前的脱敏 fixture、目标 API read path。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase shadow`。产物：canonical DTO diff、权限拒绝 diff、附件访问 diff、cursor/version diff。 | 关键 API 语义一致；不因比较器而写数据库；跨 family 访问均拒绝；任务/通知 scope 正确。 | 关闭 shadow 流量，修 repository/contract；不直接在目标上手工补差异。 | 按实际 read predicate 建 `familyId + time/version` 复合索引，比较计划前后 query plan。 |
| **DB14 写栅栏与切换** | `NOT_STARTED` | 输入：DB12 checkpoint、DB11 clean report、DB13 shadow 通过。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase cutover`。产物：router flag、切换 marker、客户端维护/重试记录、目标新写审计。 | 只有 checkpoint 通过才切 PG；目标接收新写后可追踪；无 PG 新写时可按 checkpoint 直接回源；旧客户端重试不会重复写。 | 不释放栅栏；若目标未接受新写，路由回最后一致源；若已接受，保持 PG primary 并走 forward fix，不做默认逆向 replay。 | cutover marker 用唯一键；不在切换窗口临时创建阻塞性全表索引。 |
| **DB15 回退决策演练** | `NOT_STARTED` | 输入：最终 snapshot、checkpoint、目标 change/outbox/TaskExecution、预设故障。命令：`【拟新增未存在】npm run backend:migration:rehearse -- --manifest <path> --phase rollback-decision`。产物：两分支报告：零 PG 新写时直接回源；已有 PG 新写时保持 PG 的应用 rollback/forward-fix；含丢写/重复写计数和证据。 | 覆盖切换前失败、PG 接受写后失败、worker 重启、附件失败；不要求也不把目标→SQLite replay 作为默认方案。 | 演练失败则不切换；补齐 fence/checkpoint/forward-fix 和停止规则后重演。 | 回退判定使用 checkpoint/router/commit evidence 索引；不靠全表扫描猜测是否有新写。 |
| **DB16 PostgreSQL 测试 runner** | `NOT_STARTED` | 输入：DB02 role、DB04 migrations、测试 seed、现有 `test_`/`e2e_` 约束。命令：`【拟新增未存在】npm run backend:test:guard`、`【拟新增未存在】npm run backend:test:integration -- --suite pg-migration`。产物：database/user/host 断言、重复运行报告、tenant purge 报告、TaskExecution/cursor/附件测试证据。 | runner 不能 CONNECT prod；独立账号+database；重复 API/E2E/worker/cursor/附件测试无残留；日志无秘密；通过后才评估替换 SQLite runner。 | 保留现有 `dev_test.db` 规范；PG runner 标记 `BLOCKED`，不改现有测试入口。 | 测试数据足以触发 query plan，但不以测试 plan 作为生产性能承诺。 |

## 11. 索引与性能边界

建议索引按查询合同和实际 cardinality 分阶段加入，而不是把 SQLite 既有 index 机械复制。优先候选如下：

- family sync：`FamilyChange(familyId, cursor)`；change中的删除以operation标记，不能索引不存在的deletedAt列。实体按 `(familyId,id)`定位并以version做条件更新，不能用cursor替代entity version；`UserChange(userId, cursor)`。
- 时间轴：`TimelineEntry(babyId,occurredAt DESC,id DESC) WHERE deletedAt IS NULL`，以 `occurredAt + id` 作为稳定 keyset；睡眠按 baby + start/end；报告/疫苗按 baby + date。
- 幂等和安全：`IdempotencyReceipt(actorId, scopeId, commandId)` unique；`RefreshCredential(tokenHash)` unique；设备 endpoint 或 token hash unique；审计按 user/client + createdAt DESC。
- worker：`TaskOutbox(dispatchState, phaseKey, nextDispatchAt)`，必要时加 lease/priority；`TaskExecution(status, leaseExpiresAt, kind, createdAt)`；`AiRun` 查询通过关联执行头。领取任务要用 PostgreSQL 事务锁和 `SKIP LOCKED` 的受控模式，不能仅看 Boolean claimed；`awaiting_confirmation`/`parked` 不可重派。
- 附件：contentHash/size 用于对账；family/baby + createdAt 用于授权列表；底层对象存储不要以数据库索引代替 ACL。
- 静态 reference：保留业务 ID unique 和实际过滤字段索引，避免为每一个 JSONB 字段预建 GIN；只有有稳定查询和 `EXPLAIN` 证据才加 GIN。

索引创建应区分空库 baseline 和线上增量：线上大表考虑 `CREATE INDEX CONCURRENTLY`，并记录失败后清理方式；不能在未知表规模下承诺 P95、QPS、切换时长或“零锁”。任何性能数字都必须来自隔离 PostgreSQL 18、接近生产分布的样本、固定硬件和明确 query plan，并与数据正确性验收分开报告。

## 12. 完成定义

本计划只有在以下证据都存在后，才可被父任务标记为“数据库迁移实施完成”：

1. PostgreSQL 18 空库 migrations 独立、可审阅、可重复部署，旧 SQLite history 没有被执行。
2. 47 个源 model、全部 ID/hash、日期、JSON、numeric、enum/constraint 规则都有 mapping 和对账证据。
3. 快照使用只读一致 WAL 安全路径；没有直接复制主库文件或连接生产进行试验。
4. staging、bulk ETL、附件 inventory、shadow read、统一写栅栏、最终全量快照和 checkpoint 都有可重放/可审计 marker；首发不依赖 source journal/CDC。
5. row/hash/FK/tenant/cursor/idempotency/AI task/attachment 测试通过，quarantine 只剩有批准决定的条目。
6. 切换和两分支回退决策至少各演练一次：零 PG 新写时可按 checkpoint 回源，已有 PG 新写时保持 PG 并应用 rollback/forward-fix；不能丢失或重复新写，不能回退的条件已写成停止规则。
7. PostgreSQL 测试 runner 用独立 database/role 并通过 production deny guard；在此之前现有 `dev_test.db` 测试规范保持不变。
8. 所有性能索引只作为有证据的候选，不把规划建议写成已验证性能承诺。

本文件完成的是数据库迁移手册，不是迁移执行报告；当前没有目标 schema、目标 migration、ETL 脚本、journal writer、切换开关或生产变更。
