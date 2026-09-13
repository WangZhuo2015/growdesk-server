# Baby Panel 功能对齐与原生 iOS 长期实施合同

> **2026-09-11 产品决策更新**：应用正常联网，可选择数据仅本机保存；云同步/协作需主动授权。涉及登录前置、仅缓存、本地保留和“必须联网”的规则以 [07 本地保存与按需云协作](07_LOCAL_FIRST_OPTIONAL_SYNC.md) 为准；云端事务、权限与幂等不变量继续有效。

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


状态：规划基线，未声称已实现。基线日期：2026-09-11。旧 Web 基线提交：`ed7318d`。

本文的任务是把现有 Baby Panel 的真实功能映射成可以执行、可以验收的 Swift 6 / SwiftUI 原生 iOS 计划。它服务于“完整覆盖旧功能后再发布”的目标，不把一个能录入几条数据的 MVP 当成替代品。旧 Next.js Web/PWA 继续作为兼容入口；原生工程固定放在独立 `growdesk-ios` 仓库根，新 Fastify 后端固定放在独立 `growdesk-server` 仓库根，不能把 Web 页面直接搬进 App，也不能另建平行的 `ios/` 工作区。

原生目标基线为 **Swift 6 语言模式、SwiftUI、iOS/iPadOS 17+、GRDB/SQLite、生成的 OpenAPI 客户端 + URLSession**。最低系统、Xcode 版本和实际家庭设备清单在 `IOS00_BASELINE` 固化前仍属于待确认输入；这里先锁定技术边界，不把当前环境误报成已经可构建的 App。

## 0. 阅读规则与事实边界

本文使用三个状态标记：

- **[已实现-Web]**：旧 Web 参考仓库中有对应的 route、page、service 或组件。它只证明代码存在，不证明生产部署、真实 Apple 回调、推送、OCR、跨设备同步或真机流程已经通过。
- **[兼容保留]**：现有 Web/MCP/OAuth 能力继续工作，新 iOS 通过版本化 API 接入；不能因为 iOS 未实现就删除旧入口。
- **[仅规划-iOS/Backend]**：目前仅有新服务端 workspace 与三个包骨架，尚无已验收原生工程、GRDB 数据库、OpenAPI 生成客户端或新的持久 worker；完成前不得在发布说明中写成已支持。

字段、错误码、分页、游标、版本和鉴权细节以同目录的 `02_BACKEND_CONTRACTS.md` 为主文档，本文只给出功能边界和 endpoint 族。若两份文档冲突，先修改本文件的映射，再按 02 文档实现，不在 Swift 代码中自行发明另一套协议。

当前代码事实：旧参考仓库是 Next.js 16 / React 19 / TypeScript / Prisma 7 / SQLite Web 工程；新 growdesk-server 只有基础 workspace 与三个包，新 growdesk-ios 尚无 Xcode 工程。旧 Web 已有 `app/api/**`、`lib/records/service.ts`、`lib/agent/**`、`lib/mcp/**` 和 IndexedDB outbox。旧 outbox 对所有 4xx 都删除条目，因此它是迁移依据，不是 iOS 同步实现。

目标后端为 Fastify 5 + TypeBox + Swagger，按 02/06 约定导出 **OpenAPI 3.0.3**；这是当前插件导出子集和契约门槛的固定选择，本文不把它解释成 Apple 不支持 OpenAPI 3.1，也不允许实现者自行切换到未验证的 3.1。数据层为 PostgreSQL 18 + Prisma 7，Redis + BullMQ 5 负责队列/租约，S3 负责附件。目标技术尚未在当前仓库落地，均属 [仅规划-iOS/Backend]。

## 1. 长期边界：四个权威和两个客户端

```text
SwiftUI iPhone/iPad
  ├─ 生成的 OpenAPI DTO + URLSession APIClient
  ├─ GRDB/SQLite cache + outbox + tombstone
  └─ SyncEngine / SSE subscription / APNs registration
                 │ HTTPS / Bearer
                 ▼
Fastify 5 backend（唯一业务权威）
  ├─ principal / family authorization / command service
  ├─ PostgreSQL 18 + Prisma 7 + change log
  ├─ Redis + BullMQ 5 worker：AI、OCR、ASR、通知
  └─ S3：受保护附件和缩略图
        ▲                         ▲
        │ 同一领域服务              │ 同一 OAuth/MCP 边界
旧 Web/PWA -------------------- 外部 MCP 客户端
```

目标目录只表达边界，不表示现在已经创建：

```text
growdesk-server/                     # 独立仓库；部分基础骨架已有
  apps/
    api/src/                          # Fastify routes、auth、API bootstrap
    worker/src/                       # BullMQ/任务处理器
    scheduler/src/                    # 提醒和清理调度
  packages/
    domain/src/                       # 领域服务和用例
    database/src/                     # Prisma/事务/迁移适配
    contracts/src/                    # TypeBox 单一 schema 源
    adapters/src/                     # S3、模型、APNs 等外部适配器
    testkit/src/                      # 隔离租户和契约 fixture
  prisma/schema.prisma
  prisma/migrations/
  contracts/openapi.json              # Fastify Swagger OpenAPI 3.0.3 导出
  scripts/ tests/ infra/
growdesk-ios/                        # 独立仓库；原生工程待建立
  BabyPanel.xcodeproj
  BabyPanel/                          # App、Core、DesignSystem、Features、Resources
  BabyPanelTests/ BabyPanelUITests/
  Contracts/                          # OpenAPI 快照、来源 commit/hash
# 规格唯一主本：growdesk-server/docs/plan/implementation/
```

依赖方向必须单向：SwiftUI View → Feature ViewModel → Domain/Repository → APIClient 或 GRDB；生成 DTO 不进入 UI；Domain 不依赖 SwiftUI；SyncEngine 不知道具体页面。后端 route 只做 schema、principal 和调用，不把业务逻辑复制到每个 route。Web、iOS、MCP、worker 的写操作都调用同一个 command service，才能让 change log、版本和权限一致。

两种数据范围不能混淆：

- 记录和时间轴属于 **family feed**，家庭成员有权限即可看到同一宝宝的记录；AI 会话默认属于创建者的 **user private** 空间，除非未来单独设计共享会话。
- 客户端传来的 `familyId`/`babyId` 只是目标，永远不是授权证明。后端必须从 Bearer principal 解析用户，再检查家庭成员、宝宝归属和角色。

## 2. 真实功能矩阵

下表把旧路径、原生目标、后端 endpoint 族和验收样例放在同一处。endpoint 建议均为 `/api/v1` 下的资源；实际字段、状态码和响应 envelope 以 02 文档为准。旧路径存在即标 [已实现-Web]，不代表目标 iOS 已完成。

| 旧功能/事实路径 | iOS 目标能力 | v1 endpoint 建议 | 最小验收用例 |
|---|---|---|---|
| `/login`、`/register`、`/api/auth/{login,register,me,logout}` [已实现-Web] | 原生登录、刷新、设备会话、退出、账号资料/导出/删除；设置展示/保存/再生成 recovery codes，忘记密码走恢复码入口；Keychain 保存 refresh token，不把 token 写入 GRDB | `POST /auth/login`、`POST /auth/register`、`POST /auth/refresh`、`POST /auth/logout`、`GET/DELETE /auth/sessions[/:id]`、`GET/PATCH /me`、`POST /me/export`、`DELETE /me`、`POST /auth/recovery-codes/regenerate`、`POST /auth/password/recover` | 登录后杀 App 重开仍可恢复；refresh 重放失败并清除本地凭据；近期 password reauth 后一次展示 10 个 recovery codes；恢复码单次消费并撤销旧 sessions/codes；导出只含本人授权数据；删除后凭据失效且备份恢复不复活；401 只重试一次 |
| `/onboarding`、`/api/baby`、`/api/baby/avatar` [已实现-Web] | 宝宝资料、头像、时区、孕周；显式宝宝列表和 activeBabyId | `GET/POST /families/:familyId/babies`、`GET/PATCH /babies/:babyId`、`POST /attachments` | 两个宝宝只显示自己的数据；切换宝宝后旧请求响应不能污染新宝宝 |
| `/family`、`/api/family/members`、`/api/family/join`、`/api/family/preview` [已实现-Web] | 家庭名称、成员角色/关系、邀请预览、加入/退出、权限变化 | `GET/POST /families`、`GET/PATCH /families/:familyId`、`POST /families/:familyId/invites`、`POST /families/join`、`GET/PATCH/DELETE /families/:familyId/members[/:userId]` | 非成员读/写返回 403；成员被移除后旧 token 访问 feed 失败；成员变更无离线按钮 |
| `/`、`/records/*`、`/api/records/timeline`、`/api/records/daily-summary` [已实现-Web] | Today、按家庭时区的日报、时间轴、快捷记录、空/错/待同步态 | `GET /babies/:babyId/timeline`、`GET /babies/:babyId/daily-summaries`、`GET /sync/families/:familyId/changes`、`GET /sync/me/changes` | 断网新增后立即出现在时间轴并标待同步；跨午夜按家庭时区统计；另一成员可见 |
| `/records/feeding`、`/api/records/feeding`、`lib/records/service.ts:createFeeding` [已实现-Web] | 母乳/配方/瓶喂母乳/混合、奶量、左右侧时长、吐奶、奶粉选择；离线增改删 | `GET/POST /babies/:babyId/records/feeding`、`PATCH/DELETE /babies/:babyId/records/feeding/:recordId` | 预分配 UUID 离线创建；编辑和删除也入 outbox；同操作重放只生成一条；409 显示本地/远端差异 |
| `/records/sleep`、`/api/records/sleep` [已实现-Web] | 白天/夜间睡眠，开始/结束，夜醒次数；可离线编辑/删除 | `GET/POST /babies/:babyId/records/sleep`、`PATCH/DELETE .../sleep/:recordId` | 强退后离线记录仍在；同一记录不能重复结束；时间区间跨日正确；删除产生 tombstone；喂奶用的 `NursingDualTimer` 不作为睡眠功能证据 |
| `/records/diaper`、`/api/records/diaper` [已实现-Web] | 尿/便/两者、颜色/性状、备注；可离线增改删 | `GET/POST /babies/:babyId/records/diaper`、`PATCH/DELETE .../diaper/:recordId` | 无网保存；错误字段进入可重试失败队列；家庭 feed 另一设备在 5 秒目标内出现 |
| `/food/log`、`/(main)/food`、`/api/food/logs` [已实现-Web] | 食材、多份量、接受度、状态、异常；可离线增改删；计划在线保存 | `GET/POST /babies/:babyId/records/food`、`PATCH/DELETE /babies/:babyId/records/food/:recordId`、`GET/POST /babies/:babyId/food-plans` | 同一餐重传无重复；过敏/异常备注不丢；食物日志进入日报和营养分析 |
| `/nutrition`、`/api/nutrition/analysis`、`lib/nutrition/engine.ts` [已实现-Web] | DRIs、母乳估算、辅食来源、补剂冲突和趋势；服务端权威计算，iOS 缓存带更新时间 | `GET /babies/:babyId/nutrition/analysis`、`GET /babies/:babyId/nutrition/trends` | 同一固定输入与服务端样例一致；缺网可看最后结果并标旧；不在 iOS 复制临床规则 |
| 奶粉/补剂库与计划：`/api/nutrition/products`、`records`、`schedules` [已实现-Web] | 家庭共享产品库、宝宝补剂计划、打卡；补剂记录增改删离线，产品/计划变更在线 | `GET/POST/PATCH/DELETE /families/:familyId/nutrition-products`、`GET/POST /babies/:babyId/records/supplement`、`PATCH/DELETE /babies/:babyId/records/supplement/:recordId`、`GET/POST /babies/:babyId/supplement-schedules`、`PATCH/DELETE .../:id` | 重复/过量返回 409 并要求在线确认；产品不属于家庭时 403/404；离线打卡重放幂等 |
| `/growth`、`/growth/add`、`/api/growth`、`/api/growth/chart`、WHO helpers [已实现-Web] | 手工身高/体重/头围、曲线、百分位；首版仅手工生长测量可离线增改删；图表 Swift Charts | `GET/POST /babies/:babyId/growth-measurements`、`PATCH/DELETE /babies/:babyId/growth-measurements/:measurementId`、`GET /babies/:babyId/growth-chart` | 同一测量重试无重复；服务端百分位与固定样例一致；iPad 横屏图例不遮挡 |
| `/api/growth/ocr`、`GrowthForm` 图片识别 [已实现-Web] | 拍照/图库选择、OCR 草稿；上传和识别在线，手工生长测量仍可离线 | `POST /attachments`、`POST /attachments/:id/complete`、`POST /growth/ocr-runs`、`GET /ai/runs/:runId` | 断网明确显示“需联网”；重复上传可恢复；OCR 结果只能填草稿，用户保存后才是记录 |
| `/health/vaccines`、`/api/vaccines`、`/api/vaccines/selections` [已实现-Web] | 国家/非免疫规划、地区覆盖、策略组、接种计划和完成标记；正式选择、完成/撤销和记录在线；断网只保留未提交草稿 | `GET /babies/:babyId/vaccines/schedule`、`GET/PUT /babies/:babyId/vaccine-selections`、`POST/PATCH/DELETE /babies/:babyId/vaccine-records` | 性别、月龄、地区过滤一致；在线完成/撤销在另一个成员端可见；离线草稿不进入正式 feed；来源版本显示 |
| `/health/medical`、`/health/medical/add`、`/api/medical/reports*` [已实现-Web] | 病历列表、结构化指标、图片查看；首版正式病历创建/编辑/删除在线，断网只保存手工草稿，附件/OCR 确认在线 | `GET/POST /babies/:babyId/medical-reports`、`GET/PATCH/DELETE /babies/:babyId/medical-reports/:reportId` | 手工草稿杀 App 后保留但不出现在正式 feed；在线保存/删除有版本和 tombstone；无权家庭不可见原图 |
| `/api/medical/upload`、`/api/medical/ocr`、`/api/ai/jobs*` [已实现-Web] | 医疗报告 S3 上传、OCR job、状态恢复、用户确认；wire run 状态用 `awaiting_confirmation`，确认卡可用局部 `pending_confirmation` | `POST /attachments`、`POST /attachments/:id/complete`、`POST /medical/ocr-runs`、`GET /ai/runs/:runId`、`POST /ai/runs/:runId/confirm` | OCR job 在 App 退出后继续；识别字段不能自动写正式病历；确认必须在线且检查权限；重复 confirm 幂等 |
| `/daily-summary`、`/api/ai/daily-summary`、Poster modal [已实现-Web] | 生成日报、日期浏览、重新生成、复制/分享图片；服务端 summary，原生 `ImageRenderer` | `GET /babies/:babyId/daily-summaries`、`POST /babies/:babyId/daily-summaries/runs`、`GET /ai/runs/:runId` | 网络失败保留旧日报；海报在 iPhone/iPad/深色模式无裁切；分享只导出用户选择的内容 |
| Quick AI `/api/ai/chat`、`/api/ai/sessions*`、`/api/ai/search`、`/api/ai/tips` [已实现-Web] | 私有会话、历史、文本/图片、多轮流式回答、搜索证据、tips；App 断开不取消服务端 run | `GET/POST /ai/sessions`、`GET /ai/sessions/:id/messages`、`POST /ai/sessions/:id/runs`、`GET /ai/runs/:runId`、`GET /ai/runs/:runId/events` | SSE 断线按事件序号补发；会话只对 user owner 可见；服务端持久化最终结果后才通知 |
| `/api/ai/parse-record`、`/api/ai/parse-nutrition`、`AiActionCard` [已实现-Web] | AI 解析结果只作为可编辑动作卡；写入记录前显示字段和确认状态 | `POST /ai/parse-runs`、`POST /sync/commands`、`POST /ai/runs/:runId/confirm` | 未确认不能写库；确认带稳定 actionId；重试不重复创建；解析错误可修改或丢弃 |
| `/api/agent/voice`、`/api/asr/transcribe`、`/api/agent/voice/logs*` [已实现-Web] | 按住说话、上传/ASR、快速查询、异步结果、历史和已读；录音不依赖浏览器 MediaRecorder | `POST /voice/runs`、`GET /ai/runs/:runId`、`GET /voice/logs`、`PATCH /voice/logs/:id` | iOS 锁屏/切后台后请求状态可恢复；写入型语音走确认；历史可见且未读结果可深链；TTS 文本不泄露病历详情到通知 |
| `/oauth/authorize`、`/api/oauth/*`、`/mcp` [已实现-Web/兼容保留] | 设置中查看/撤销外部 MCP 连接；管理 API 与外部 OAuth 协议端点严格分离；App 登录与 MCP OAuth 严格分离 | 管理：`GET /connections`、`DELETE /connections/:grantId`；协议：`GET /.well-known/oauth-authorization-server`、`GET /.well-known/oauth-protected-resource/mcp`、`GET/POST /oauth/authorize`、`POST /oauth/token`、`POST /oauth/revoke`、`POST /mcp` | 设置页只调用 connections 管理接口；ASWebAuthenticationSession + PKCE S256；`aud=<baseUrl>/mcp` token 不能访问业务 API；deny/cancel/retry/callback 均可回到 App |
| `/api/user/tokens`、`/api/user/tokens/:id`、`PersonalTokenModal`、`/api/agent/voice/logs*` [已实现-Web] | 设置中列出/创建/撤销 PAT、显示使用情况和最后使用时间；Siri/快捷指令语音历史、未读结果和深链完整保留 | `GET/POST /me/tokens`、`DELETE /me/tokens/:tokenId`、`GET /me/ai-usage`、`GET /voice/logs`、`PATCH /voice/logs/:id` | PAT 明文只在创建响应出现；撤销立即阻止语音调用；usage 明示 estimated/final；voice history 能按宝宝/状态回到正确页面；PAT、App session、MCP grant 三者不能混用 |
| `/food/library`、`/api/food/items`、`/api/food/feeding-guidelines` [已实现-Web] | 食材图鉴、月龄、防噎/过敏提示、家庭尝试状态；资料只读，家庭状态在线同步 | `GET /knowledge/foods`、`GET /knowledge/feeding-guidelines`、`PUT /families/:familyId/food-status/:foodId` | 资料显示来源日期；危险提示可被 VoiceOver 读到；切换宝宝不会改变家庭食材状态 |
| `/books`、`/api/books*`、`/development`、`/api/development/*` [已实现-Web] | 绘本收藏/阅读次数、里程碑、预警征象、亲子活动 | `GET /knowledge/books`、`PATCH /families/:familyId/book-status/:bookId`、`GET /knowledge/milestones`、`GET /knowledge/warning-signs`、`GET /knowledge/activities` | 收藏/阅读状态跨成员一致；里程碑按月龄和来源过滤；预警有明确“咨询专业人员”文案 |
| `/weather`、`/api/weather` [已实现-Web] | 城市/定位天气、逐时预报、宝宝户外建议；只读可缓存 | `GET /weather?lat=&lon=&city=` | 无权限定位时仍可手动城市；超时显示上次时间；不阻塞 Today 首屏 |
| `/notifications`、`/api/notifications`、`/api/push/*` [已实现-Web] | APNs 注册/撤销、家庭动态、疫苗/日报提醒、已读/忽略、深链；本地提醒与远程提醒分开 | `GET /notifications`、`POST /notifications/:id/read`、`PUT/DELETE /devices/:installationId/push`、`GET/PUT /me/notification-preferences` | 拒绝通知权限不影响记账；同一 eventId 不重复；点击通知进入正确宝宝/记录；锁屏不显示病历正文 |
| 头像、报告原图、成长照片和 AI 多图上传 [现有分散附件；统一图库为可选新增] | 先覆盖头像、报告、成长照片和 AI 多图的附件索引、缩略图、权限、删除/留存和引用关系；统一图库浏览增强不作为旧功能首发债务；原图从 S3 受保护下载 | `POST /attachments`、`GET /attachments?scope=...&purpose=...`、`POST /attachments/:id/complete`、`GET /attachments/:id/content`、`DELETE /attachments/:id` | 无权用户拿不到下载内容；取消上传可恢复；删除引用中的原图有明确提示；HEIC/EXIF 策略固定；可选图库打开时仍复用同一授权索引 |

矩阵中的“记录”指有稳定 UUID、版本和删除 tombstone 的结构化记录。首版正式离线 CRUD 只包括 `feeding`、`sleep`、`diaper`、`foodLog`、`supplementRecord`、`growthMeasurement` 六类；创建、编辑、删除均入队，`restore` 仍按 02 在线发起。手工疫苗和手工病历只能在本地保存草稿，正式创建/编辑/删除必须在线，不能把草稿或未确认 OCR 结果放进正式 feed。家庭成员变更、邀请、产品/计划共享变更、附件上传、OCR 任务及医疗 OCR **确认**也必须在线。

02 的 `entityType` 当前固定为上述六类；若以后要把疫苗或病历正式纳入离线 CRUD，必须先在 02 的 `entityType`、数据库版本、OpenAPI 和 golden fixture 中增项，再生成客户端，不能在 iOS 私自加一条未被后端识别的命令。REST 资源路径的写入仍转换到同一 `POST /sync/commands` 用例，字段映射和单位以 02 §10 与 `FIELD_MAPPING.md` 为准。

## 3. 原生模块和依赖边界

### 3.1 模块职责

| 模块 | 只负责 | 可依赖 | 禁止 |
|---|---|---|---|
| `App` | 环境、深链、scene 生命周期、依赖注入、account scope | Foundation、SwiftUI | 直接写 SQL 或在 View 中拼 URL |
| `Core/Domain` | Baby、Family、Record、Run、Attachment、错误和纯值规则 | Foundation | 依赖 SwiftUI、GRDB、URLSession |
| `Core/Networking` | OpenAPI 生成 DTO、URLSession transport、Bearer、错误解码、SSE parser | Foundation、生成代码 | 手写与 OpenAPI 平行的一套 DTO；保存 token |
| `Core/Persistence` | GRDB migration、查询、事务、账号分区、缓存、outbox | GRDB、Domain | 发 HTTP、解析 UI 文案 |
| `Core/Sync` | pull cursor、push outbox、冲突、重试、权限失效、任务取消 | Persistence、Networking、Domain | 依赖某个 Feature 的 ViewModel |
| `Core/Auth` | Keychain、刷新、设备会话、账号切换、MCP 连接状态 | Networking、Persistence | 把 MCP access token 当业务 access token |
| `Core/Attachments` | 图片/音频压缩、S3 multipart/presigned、缩略图、加密文件缓存 | Networking、Persistence、Photos/AVFoundation | 将服务端密钥放 App；上传未授权路径 |
| `Core/AI` | run 状态、SSE、动作卡、pending_confirmation、会话私有性 | Networking、Persistence、Domain | 在 iOS 执行模型、把客户端历史当权威 |
| `Features/Today Records` | 快速录入、时间轴、日报和离线状态 | Domain、Repositories、DesignSystem | 每页自行 fetch 同一记录 |
| `Features/Health Nutrition` | 成长、营养、疫苗、病历、知识 | 同上 | 在客户端复制 WHO/DRIs/疫苗权威算法 |
| `Features/Family Settings` | 多宝宝、成员、通知、外部连接、数据管理 | Auth、Sync、Repositories | 离线执行成员权限变更 |
| `DesignSystem` | 字体、颜色、卡片、状态、可访问性样式 | SwiftUI | 保存业务数据或决定权限 |

生成客户端只接受后端导出的 OpenAPI 3.0.3；手写的 `URLSession` transport 负责认证、超时、取消和重试策略，不能手写每个 endpoint 的 JSON 编码。SSE 不强行塞进生成客户端：使用同一认证 transport 的 `SSEClient`，将事件解码成 Domain event。

认证依赖不能递归：AuthService的login/refresh/recover使用不带自动refresh拦截器的基础transport；业务transport通过注入的CredentialProvider取token，401时只调用一次AuthService刷新。Core/Auth与Core/Networking通过协议注入，不互相持有会触发刷新循环的实现；refresh自身401直接终止，必须测试single-flight不会等待自己。

### 3.2 模块可交付边界

一个弱 Agent 只处理一个模块和一个验收文件。跨模块改动必须先补接口/迁移，再改调用方；不能在 `Features` 内直接新增数据库列，也不能把临时 mock URL 合并进生产配置。每个 PR 必须写清：输入 fixture、修改的 migration、可见状态、失败回滚、测试命令和未完成项。

## 4. GRDB 缓存、离线窗口和 outbox

### 4.1 本地数据形状

GRDB 数据库按 `accountId` 建立逻辑分区；退出或切换账号时，旧分区不能被新 principal 读到。建议的核心表（字段以实现时 schema review 为准）：

```text
AccountScope(accountId, userId, activeFamilyId, activeBabyId, lastAuthAt)
FamilyCache(familyId, version, payload, updatedAt)
BabyCache(babyId, familyId, version, payload, updatedAt)
RecordCache(id, accountId, familyId, babyId, kind, version, payload,
            deletedAt, syncState, serverUpdatedAt)
ChangeCursor(accountId, scopeType, scopeId, epoch, position,
             mode, highWater, schemaVersion, expiresAt)
OutboxCommand(operationId, accountId, familyId, babyId, kind, recordId,
              operation, baseVersion, body, bodyHash, idempotencyKey,
              state, attempts, nextAttemptAt, lastError, createdAt)
Conflict(id, operationId, recordId, localBody, remoteBody, remoteVersion, state)
AttachmentCache(id, accountId, familyId, babyId, localPath, uploadState, sha256)
```

`RecordCache` 和 `OutboxCommand` 必须在一个 GRDB transaction 中写入。记录 UUID 由客户端预分配，服务端以该 UUID 作为稳定主键；不要先 POST 得到服务端 ID 再写本地。删除不是物理删本地行，而是写 `deletedAt` 和 outbox delete command，等服务端确认后仍保留 tombstone 到 cursor 已安全越过。

客户端最多允许 **30 天个人离线窗口**；family feed 的增量保留和可回放窗口为 **90 天**，user feed 作为独立 scope 遵循 02 契约的 retention floor。`ChangeCursor` 只按 `accountId + scopeType + scopeId + epoch` 分区，scope 是 `family` 或 `user`，不能为每个 baby 另造游标；记录的 `babyId` 仍是 projection/filter 字段。cursor 同时持有 position、固定 highWater、schemaVersion 和 `page|tail` mode：中间页固定 highWater，终页切到 tail，下一轮重新取高水位。超过 retention floor 或 epoch 改变时接受 410 `SYNC_RESET_REQUIRED`，停止盲目补发，执行全量 snapshot + cursor 重建，同时保留未确认 outbox 并让用户处理冲突。缓存过期不等于删除本地待同步记录。

### 4.2 首版六类日常记录 CRUD 离线状态机

```text
localDraft → queued → dispatching → acknowledged
                         ├─ retryable（网络/5xx/429）→ queued
                         ├─ conflict（409）→ needs_resolution
                         ├─ forbidden（403）→ blocked_permission
                         └─ invalid（4xx）→ failed_visible
```

`waiting_dependency` 是额外的本地 outbox 状态：创建命令尚未收到 ack 时，后续编辑、结束计时或删除不能猜 `baseVersion`，也不能提前冻结成可发送的子命令；它们只保留本地草稿，待父创建 ack 返回 canonical version 后再填版本并冻结 body/key。发送 wire batch 时每批命令必须互相独立，不能把同一 entity 的 create 与 edit/end/delete 一起打包。

上述六类正式记录的创建、编辑、删除均支持离线。编辑保存 `baseVersion`；离线删除保存删除时看到的版本。outbox 第一次 dispatch 前冻结完整 `body`、`bodyHash` 和 `Idempotency-Key`；之后重试只能使用被冻结的三项，不得重新从当前 ViewModel 组装 body。服务端对相同 key + 相同 hash 返回同一结果；相同 key + 不同 hash 返回明确冲突。疫苗和病历正式 CRUD 不进入这个状态机，只有本地草稿。

`409` 必须可见：显示本地变更、远端变更、字段差异、当前版本和“保留远端/覆盖为本地/编辑后重试”选项。覆盖不是静默行为，必须生成新的 operationId 和新的 baseVersion。`403` 不得重放越权请求；成员被移除后清理该家庭可见缓存。`401` 先尝试一次 token refresh，失败则锁定需要登录。`429` 使用服务器 `Retry-After`，而不是固定快速循环。

`GET /api/v1/sync/families/:familyId/changes` 和 `GET /api/v1/sync/me/changes` 是所有写入口（Web、MCP、AI、iOS）共享的 family/user change log 消费接口：按 scope、单调 cursor、分页 highWater 和 tombstone 拉取。中间 page 的 `nextCursor` 保持本轮 highWater；终页必须返回 tail cursor，否则下一轮不能看到新提交。retention floor 或 epoch 不匹配返回 410 `SYNC_RESET_REQUIRED`。`POST /api/v1/sync/commands` 是跨资源离线命令的统一入口；AI run 的确认按 02 文档使用 `POST /api/v1/ai/runs/:runId/confirm`，资源 route 仍然保留清晰的人类可读路径，但最终都走同一 command service。不能仅用 `updatedAt > lastSync` 代替 cursor。

### 4.3 账号切换

切换流程固定为：停止新写入 → 取消旧账号请求和 SSE → 读取旧账号 outbox 数量 → 用户选择同步/保留/明确放弃 → 锁定旧分区 → refresh 新账号 → 读取 `/me` 和 `GET /families` → 对选中家庭读取 `GET /families/:familyId/babies` → 选择 active family/baby → 打开新分区 → 拉 snapshot + cursor。所有 repository 方法都必须显式接收 `AccountScope`，不能使用全局的“当前宝宝”单例。

账号切换验收：A 账号有未同步记录时切到 B，B 看不到 A 的 cache、图片、AI 会话和 outbox；旧请求晚到时被 request scope 丢弃；重新登录 A 后仍可看到待同步项。退出时如未选择放弃，默认不删除本地待同步记录；用户明确放弃后才标记并安全清理。

## 5. AI、语音、SSE 和 MCP 授权

### 5.1 持久 AI run

旧 `/api/ai/chat` 会在 HTTP 请求中运行 agent，`request.signal` 断开可能中止执行；旧 `AiJob`/OCR 表存在，但不等于 worker 可重启恢复。目标后端必须先写 user message 和 `run`，返回 `202 + runId`，再由 Redis/BullMQ 5 worker 执行。`runId` 是公共 `TaskExecution` 与 `AiRun` 一对一同主键暴露的 ID；iOS 只把它当 opaque ID，不重复实现后台执行头。wire 状态至少为 `queued → running → awaiting_confirmation → succeeded|failed|cancelled`，带 lease、heartbeat、attempt、超时和可见错误；`awaiting_confirmation` 是唯一等待确认的 run 状态。

AI session 默认 user-private；records tool 写入仍按 family authorization。AI 计划改变记录时先产出确认 action，包含 actionId、字段 diff、目标 baby、来源、过期时间和风险提示；iOS 确认卡可以把 action 的局部 UI 状态叫 `pending_confirmation`，但不能把它当第二个 wire run 状态。用户在线确认后才调用 `/ai/runs/:runId/confirm`。重试使用 actionId 幂等，并重新检查家庭成员权限。取消 App、锁屏或断网只取消 SSE 订阅，不取消已经接受的 run。

run 进入 `awaiting_confirmation` 后释放 worker lease，不占用 worker 并发；确认仍必须在线并重新检查权限、planHash 和版本。确认卡默认 30 分钟过期，过期 run 可重新提交新的 action/attempt，不能复用已过期确认。

SSE wire 的 `type` 字段必须使用 02 的下划线值：`run_started`、`text_delta`、`tool_proposed`、`tool_started`、`tool_succeeded`、`awaiting_confirmation`、`attempt_restarted`、`run_failed`、`run_cancelled`、`run_succeeded`。每条事件以 `(runId, seq)` 唯一，客户端保存最后 `seq`，通过 `Last-Event-ID`/`after` 补发；不能另造dotted type、`kind`、`eventId` 或 `sequence` wire字段。iOS 用 `URLSession.bytes` + `AsyncThrowingStream`；重连先补事件，补不到则拉 run snapshot 和完整 session message。最终结果先落库再发通知，通知只做唤醒，不承载权威正文。

### 5.2 语音

iOS 用 `AVAudioSession`/`AVAudioRecorder` 或 `AVAudioEngine` 产生受限时长的 m4a/wav，前景录音结束后才上传。ASR、意图识别和写操作全部服务端完成；“快速查询”只是低延迟优化，不能绕过 principal。写入型语音必须经过确认卡，或由明确的系统快捷指令携带用户确认上下文。音频临时文件进账号分区，上传完成/失败按留存策略清理，日志只存 hash、时长和状态，不存秘密或完整病历正文。

### 5.3 MCP 与 iOS 登录分离

MCP 保留 `/mcp`、OAuth metadata、授权页、动态 client 注册、PKCE S256、token/revoke；iOS 在设置中展示已连接客户端和 revoke 入口。原生登录只获取业务 API 的 app audience token；MCP token 的 `aud=<baseUrl>/mcp` 只能访问 MCP。禁止把 `baby:read/write` MCP token 塞进普通 APIClient，禁止把 App client secret 编进二进制。

若 iOS 需要连接授权流程，使用 `ASWebAuthenticationSession` 和系统回调 scheme/universal link，验证 state、PKCE verifier、单次 code、redirect URI；取消、拒绝、超时和重试必须回到设置页而不是把 Safari 留在前台。这个闭环要在真实 iPhone 上测，静态审查不算通过。

## 6. 附件、图库、渲染和通知

### 6.1 S3 附件与可选图库增强

后端只给短时presigned upload URL；下载统一GET `/attachments/:id/content`经API鉴权流式代理，App不接触S3 secret或公开医疗读URL。上传流程是 `create upload`（绑定 account/family/baby、用途、sha256、大小）→ `PUT`/multipart → `complete` → 触发 OCR/缩略图 job。断线重试使用同一 uploadId 和块 hash；服务端完成后才允许创建医疗 OCR 或 AI run。

如果实现统一图库增强，它也不是把 S3 目录暴露给用户，而是带 owner、family、baby、用途和引用的附件索引。首发 parity 只要求头像、成长照片、病历原图和 AI 多图等已有场景都能通过同一受保护附件模型完成；统一图库浏览器是 optional，不得成为旧功能发布门槛。`GalleryRepository` 只读已授权 metadata，按缩略图/原图分层下载；删除先检查报告/测量/会话引用和留存策略。上传前固定 HEIC 转码、最大尺寸、EXIF 地理信息剥离和失败清理规则，医疗原图的用户可见性与删除必须有审计记录。

### 6.2 原生渲染

- WHO 曲线和营养趋势用 Swift Charts；服务端返回点、单位、来源版本和百分位，iOS 只负责坐标、筛选和可读标签。
- AI Markdown固定用`swift-markdown`解析AST并由SwiftUI组件渲染；AttributedString仅处理行内样式。覆盖段落、标题、列表、表格、代码块、链接及附件，不把表格/报告内容降为丢字段的纯文本。raw HTML不执行，外链限制http/https且打开由用户触发，图片走受授权附件。增量文本200ms节流解析，20k字符/200事件样例验证滚动及内存；解析器版本在BOOT-01锁定并加入SPM，不能直接跟main。[Swift Markdown官方仓库](https://github.com/swiftlang/swift-markdown)。
- 日报海报用 SwiftUI view + `ImageRenderer` 生成 PNG/PDF，再用 `ShareLink`；不复用旧 `html-to-image`/Canvas，也不把头像 URL 直接当成可公开资源。
- 加载、空、过期、离线、失败、权限撤销和待确认状态都是设计系统组件；动态字体、深色模式和减少动态效果都必须覆盖。

### 6.3 通知

`PUT /devices/:installationId/push` 注册 token，按 user、environment、bundle 绑定；`DELETE` 注销，APNs 失效也要删除。服务端事件带稳定 `eventId`/`dedupeKey`，本地和远程提醒不能重复。锁屏文案只写“有新的家庭动态/助手结果”，打开后按深链拉权威内容；不得在 payload 放宝宝姓名、病历数值、AI 原文或 token。

拒绝通知权限不影响记录、同步和 AI；前台恢复时始终 pull sync。后台刷新、静默推送和 BGTask 只是加速手段，不能当作可靠 worker。提醒设置按 user 或 family 明确归属，成员变更/权限撤销必须在线完成。

## 7. 多宝宝、iPad、无障碍和真机门槛

### 7.1 多宝宝

App 启动先加载用户可见的 family/baby 列表，再显式选择 activeBaby。所有 cache key、outbox、SSE、attachment、deep link 都带 babyId；AI session 若没有 baby scope 也必须明确显示“通用/家庭”而非暗中使用第一个宝宝。服务端不得用 `findFirst()` 猜宝宝，客户端也不得复刻旧入口的首宝宝默认值。

切换宝宝时取消旧宝宝的查询、清空只读 view state、保留各自 cursor；迟到响应检查 request generation 和 scope 后再写库。跨宝宝对比以后再做，首版先确保不会串数据。

### 7.2 iPad 和可访问性

iPhone 采用 Today + 快速录入 sheet；iPad 使用 `NavigationSplitView`/主从布局，左侧家庭/宝宝/功能，右侧时间轴、图表或 AI 会话，横竖屏都不依赖固定宽度。弹出录入表单不能挡住键盘或 VoiceOver 焦点。支持 Dynamic Type、VoiceOver 标签/值/提示、最小触控区域、色盲不只靠颜色、Reduce Motion、深色模式和 RTL 基础检查。

真机至少覆盖一台较旧 iPhone、一台当前大屏 iPhone、一台 iPad（竖屏/横屏），并使用真实相机、图库、麦克风、APNs sandbox、低电量/锁屏/切后台/杀进程、飞行模式和隔离测试家庭的两个 `test_`/`e2e_` 成员账号。模拟器截图、Swift 单测、Web E2E 都不能替代这些证据。

## 8. 可交给弱 Agent 的 IOSxx 执行包

每包只能改声明的目录；前置输入缺失就停在报告中，不要用 mock 充当完成。实现者任务状态统一只能写 `IMPLEMENTED_NOT_REVIEWED` 或 `BLOCKED`，不能自行写 `ACCEPTED`；最终验收由 06 的 reviewer 门禁完成。`FIELD_MAPPING.md` 是契约交付物，必须逐资源完成后才能把矩阵标为已覆盖。括号内命令若当前 `package.json` 没有，标 `【拟新增】` 后即可在本任务授权范围内添加并验证，不另行请求无意义批准；只有变更架构/协议或生产切换才停在对应门禁。

| 包 | 前置输入 | 步骤 | 产物 | 验收 | 禁止事项 |
|---|---|---|---|---|---|
| `IOS00_BASELINE` | 04 文档、02 契约、`FIELD_MAPPING.md`、`ed7318d` 路由清单 | 扫描旧 page/API/service；逐行标实现状态；锁定设备和延期决策 | 功能矩阵勾选版、设备清单、未实现差距表 | 每个旧 page/API 有目标或延期理由；标出已实现/规划 | 不修改旧 Web；不把路线图写成已完成 |
| `IOS01_CONTRACT` | 02 的 OpenAPI 3.0.3、`FIELD_MAPPING.md`、错误码、auth/sync 示例 | 校验 schema 版本；生成 DTO；写 auth/sync/error fixture；接 URLSession transport | `contracts/openapi.json`、生成 Swift DTO、解码 fixture、APIClient skeleton | `【拟新增】swift-openapi-generator` 生成结果可编译；未知字段可解码；401/403/409/429 可测 | 不手写第二套 DTO；不自行切换到未验证的 OpenAPI 3.1；不吞掉错误 |
| `IOS02_AUTH_FAMILY` | auth、recovery-code、family、baby endpoint；PKCE 回调约定 | 做 Keychain/session；加载 families/babies；接 deep link；实现成员在线变更；接 recovery codes 展示/保存/再生成和忘记密码恢复 | Keychain auth、AccountScope、家庭/宝宝选择、成员设置页、recovery-code flow | 刷新/撤销/切账号隔离；成员变更在线；近期 password reauth 后一次展示 10 个 code；恢复成功消费 code 并撤销旧 sessions/codes；越权 403；真机 cancel/retry/callback | 不保存 secret/token 或 recovery code 到日志/UserDefaults；不接受客户端 familyId 作为权限；不增加邮件恢复栈 |
| `IOS03_GRDB_CACHE` | 记录 schema、30/90 天规则、固定时间样例 | 写 migration；建 scope/cache/cursor；实现 repository 事务；做重启迁移测试 | GRDB migrations、repositories、cache/cursor、迁移测试 | 一次事务写 record + outbox；重启不丢；旧 scope 不可读 | 不用全局 store；不把服务端 JSON 直接当 UI 模型；不依赖本地算法替代权威 |
| `IOS04_OUTBOX_SYNC` | sync/commands 契约、409 示例、cursor/tombstone | 实现冻结 payload；按状态机 dispatch/pull；持久化冲突；做窗口过期演练 | outbox actor、冻结 body/key、重试、冲突 UI、sync diagnostics | 离线 CRUD；同 key 同 body 幂等；同 key 异 body 冲突；409 可见；30 天过期重建 | 不删除全部 4xx；不修改已 dispatch body；不静默覆盖远端 |
| `IOS05_TODAY_RECORDS` | records route、时区/单位/枚举、DesignSystem | 建 Today repository；接六类记录表单；接时间轴/日报；跑飞行模式流程 | Today、时间轴、feeding/sleep/diaper/food/supplement/growth 表单 | 六类记录飞行模式创建/编辑/删除，强退后重开；家庭成员看到；跨午夜正确；create 未 ack 的依赖编辑停在 waiting_dependency | 不在 View 直接 fetch/SQL；不显示“已同步”而未收到 server ack；不把同一实体多命令塞同一 wire batch |
| `IOS06_HEALTH_NUTRITION` | growth/nutrition/vaccine/medical DTO 和 reference fixtures | 接只读分析和图表；接手工生长测量；分离产品/策略在线写；接疫苗/病历草稿和 OCR | Swift Charts、营养/疫苗/病历功能页、服务端结果缓存 | 固定样例一致；六类正式记录（含生长测量）离线；疫苗/病历仅草稿离线、正式 CRUD 在线；产品/计划/策略在线；OCR 只是草稿 | 不复制 DRIs/WHO/疫苗规则；不把 OCR 自动确认为医疗记录；不把 draft 当正式 feed |
| `IOS07_ATTACH_GALLERY` | S3 presign、附件 policy、HEIC/EXIF/留存规则 | 写 upload actor；接相机/图库；存已有场景索引/缩略图；测取消、重试和权限；统一图库仅作 optional 增强 | upload actor、缩略图、受保护预览、可选 GalleryRepository | 断点/重试/取消；无权下载失败；引用删除提示；真机相机/图库；旧附件场景不依赖独立图库才能发布 | 不把 S3 secret 放包内；不把公开 URL 写入通知；不永久留临时原图；不把 optional gallery 当 parity 阻塞 |
| `IOS08_AI_SSE_VOICE_MCP` | BE-08A/BE-08B 的公共 `TaskExecution` + `AiRun` 同主键 ID、run/event/action schema、MCP OAuth metadata、connections/PAT/usage 路由 | 接 run/SSE；实现重连和确认卡；接录音/ASR；接 OAuth 设置、`GET/DELETE /connections`、PAT 与 usage、voice history | SSEClient、AI history、pending confirmation、录音/ASR、连接管理、token/usage/history UI | 断线补事件；App 强退后 run 可恢复；未确认不写；MCP token 与 app token 分离；PAT 撤销即时生效；语音历史可深链 | 不在 App 跑模型；不把断 SSE 当取消 run；不把 MCP token 调业务 API；不把 PAT 明文写日志；不另造 iOS 后台任务 ID |
| `IOS09_NOTIFICATIONS` | APNs env、deep link、event dedupe、隐私文案 | 调用 `PUT/DELETE /devices/:installationId/push`；映射 eventId；实现本地/远程设置；测深链和锁屏 | token registration、通知中心、偏好、local/remote scheduler adapter | 拒绝权限仍可用；重复 event 一次；深链正确宝宝；锁屏无敏感内容 | 不假设 silent push 必达；不在 payload 放病历/AI 正文 |
| `IOS10_IPAD_A11Y_RENDER` | DesignSystem、目标设备、无障碍 checklist | 做 split view；替换图表/海报渲染；逐项跑 VoiceOver、动态字体和横竖屏 | iPad split view、海报 ImageRenderer、VoiceOver/动态字体修复 | 三设备、横竖屏、深色/大字/Reduce Motion、海报分享通过 | 不用固定像素遮挡键盘；不以截图代替交互；不嵌任意 WebView |
| `IOS11_PARITY_RELEASE` | 全矩阵、隔离 `test_`/`e2e_` 账号、CI/TestFlight 环境 | 逐行收集证据；跑回退/删除演练；检查隐私/配置；生成发布签字单 | parity report、真机视频/截图、回退与数据删除演练 | 所有旧功能有原生覆盖或批准延期；旧 Web 仍可用；无 P0/P1 数据/权限问题 | 不因 MVP 页面可用就提交全量发布；不读 secret 或写生产测试数据 |

每包建议附三类证据：本地单测/契约结果、隔离后端集成结果、真实设备交互记录。当前旧 Web 参考仓库可继续使用 `npm run test:api:server`（已有命令，使用 `dev_test.db`/3089 规则）；原生和新 backend 的 `【拟新增】` 命令必须建立独立 test/staging 数据库，测试用户统一 `test_`/`e2e_` 前缀。不得为了截图向 Cecilia 或真实宝宝写入演示记录。

## 9. 完整覆盖后的发布门槛

发布前必须把矩阵逐行变成证据，而不是只检查首页是否能打开：

1. 每个旧 page/API 至少有一个原生入口、一个 v1 endpoint、一个离线/在线边界和一个验收用例；延期项要有产品负责人签字的替代路径。统一图库是可选增强，不计作旧 page/API 的首发缺口；头像、报告原图、成长照片和 AI 多图等已有附件场景仍必须覆盖。
2. 记录 create/edit/delete 在无网、杀进程、恢复网络、重复重放、409 和权限撤销下可解释；重复记录为零，tombstone 不丢。
3. AI/OCR/ASR 的持久 job 在 worker 重启和 App 退出后仍有可查询终态；run 处于 `awaiting_confirmation` 或 UI action 处于 `pending_confirmation` 时，在线确认前没有正式医疗或家庭记录写入。
4. 两个家庭成员、两个宝宝、两台设备和账号切换都通过；MCP、Web、iOS 的写入都能被同一 sync cursor 收到。
5. 真机通过相机、麦克风、图库、APNs、锁屏、后台、飞行模式、VoiceOver、Dynamic Type、iPad 横竖屏；Apple 审核所需账号删除、隐私和第三方 AI 同意文案与真实数据流一致。
6. 生产发布前只使用 staging/production 的正式 URL 和配置注入；绝不从源码、测试 fixture、日志或 App 包读取/写入 secret。所有新命令、迁移、worker、监控和回滚脚本都注明是否 `【拟新增】`，并在独立环境演练。

最终切片顺序固定为：先完成 `IOS01_CONTRACT`、`IOS02_AUTH_FAMILY`、`IOS03_GRDB_CACHE`、`IOS04_OUTBOX_SYNC`，再做 Today/记录；随后并行完成健康营养、附件、AI/语音和设置；最后做 iPad/无障碍、完整矩阵和发布证据。Web 保留到 iOS 全矩阵验收完成，不能因为新 App 已经能记录一次喂奶就关闭旧入口。

## GrowDesk 独立仓库交接补充（路径调整）

服务端 schema/export 归 growdesk-server；IOS01 消费已验收导出，在 growdesk-ios 的 `Contracts/openapi.json` 固定快照，并用 `Contracts/source.json` 记录源仓库、commit、契约版本与 SHA-256。生成客户端及 CI 只读取该快照，不依赖相邻目录或浮动分支。契约变更分别记录两仓库 commit 和验证结果；不维护第二套手写 DTO。BOOT/BE/DB/OPS 在服务端实施，IOS 在原生仓库实施；BE-12 涉及旧 Web 的部分须单独限定修改范围并提供该仓库的 diff/证据。详细入口见 growdesk-server 根 START_HERE.md。
