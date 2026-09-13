# 06 — 实现 Agent 任务手册与 Review 门禁

> **2026-09-11 产品决策更新**：应用正常联网，可选择数据仅本机保存；云同步/协作需主动授权。涉及登录前置、仅缓存、本地保留和“必须联网”的规则以 [07 本地保存与按需云协作](07_LOCAL_FIRST_OPTIONAL_SYNC.md) 为准；云端事务、权限与幂等不变量继续有效。

> 路径约定（2026-09-11 更新）：服务端目标根目录为 `/Users/wangzhuo/Documents/GitHub/growdesk-server`，原生端为同级 `growdesk-ios`；完整计划唯一主本位于服务端 `docs/plan/`。下文“旧 Web/源系统/现有来源”中的 `app/`、`lib/`、`prisma/`、`scripts/`、package 和 SQLite 路径均相对旧参考仓库 `/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia`；目标服务端路径相对 `growdesk-server`，Swift 工程路径相对 `growdesk-ios`。不要在旧 Web 内新建后端，也不要在服务端内嵌套 iOS 工程。既有代码事实基于旧审查基线，开工须重新核对。


状态（2026-09-11 更新）：BOOT-01 / IOS00_BASELINE 已有本地复核报告，分别见两仓库 evidence/reviews/2026-09-11-r3/。当前推进 BOOT-02，后续业务任务仍按依赖验收；骨架、文档和本地测试不能代表部署或完整产品完成。本文不是让Agent一次完成整个项目的巨大提示词。一次只领取一个任务；复杂任务按本文子步骤拆成小提交，完成证据后才领取依赖任务。任务负责人不能自行把功能删出首发范围。

## 1. 开工规则

1. 先读适用AGENTS、当前任务和引用的协议章节，记录git HEAD、branch、dirty文件。不覆盖他人的修改；自己的任务用`codex/`前缀分支/隔离worktree。是否提交/推送依用户授权，不能暗自push。
2. 不读生产`.env`、不连生产、不启动现有3088服务、不运行旧`deploy/db:push/db:restore`。规划授权不等于已授权实施/部署；本手册供后续明确实现任务使用。
3. 开工时查看实际工具版本、scripts和目录。本文标“拟新增”的命令必须先在对应任务实现，不能复制到终端期待它已经存在。
4. 涉及Next Web代码时先读安装版本的`node_modules/next/dist/docs/`；当前未安装时先按lockfile安装再读，不能凭旧版Next习惯写接口。
5. 一次任务建议覆盖一个用例、3–8个核心文件和对应必要测试；任务超出这个体积时先拆小任务，不降低验收门槛。
6. 不改本任务以外的类型/契约/数据库schema来让测试勉强通过。跨任务依赖需声明并由相关任务先完成。
7. 禁止`any`掩盖协议错误、`skip`失败用例、mock掉正在验证的行为、catch后返回成功、静态假AI结果、无限重试、全表查询后内存分页。
8. 各阶段在隔离环境完成并整合，等完整首发门禁通过后再切换生产。保留旧Web不是让新后端永久双写SQLite。

## 2. 阅读路线与文档权威

第一次接任务：读`01`第2/5/7/8节、本文第1/3/7节，再按任务只读必要文件。

| 工作 | 必读 | 不必每次加载 |
|---|---|---|
| 普通后端route/业务 | 02通用契约+相关领域；04对应行；任务卡 | 全部迁移/运维细节 |
| 认证/同步/AI | 02对应完整章节；01边界；相关负向测试 | 其他低频页面实现 |
| 数据库/ETL | 03全部；02表与cursor/事务语义；AGENTS | iOS视觉细节 |
| iOS功能 | 04相关任务；02输入输出/错误/同步；对应OpenAPI片段 | 全部Node实现源码 |
| 部署/性能 | 05全部；02队列/恢复；03切换/回退 | UI代码 |

优先级见01；02是跨端协议权威。某个命令/路径在分册中仅为建议、与本文根脚本不一致时，在BOOT-02统一实现下列入口，分册可作为内部脚本路径，不要额外维护两套测试体系。

## 3. 统一命令接口（目标行为，逐项验收）

服务端根 package.json 已声明部分 backend:* 和 dev:* 脚本，但 scripts/apps/Prisma 等实现尚不齐全，声明不等于可运行。由 BOOT-02 和各专项任务核对并补齐，不覆盖用户骨架或旧 Web 脚本。下表 npm 命令均在 growdesk-server 根运行；iOS 命令在同级原生仓库执行。命令返回非零代表未通过；不得把shell exit code吞掉。

| 根目录命令 | 负责创建的任务 | 必须具备的行为 |
|---|---|---|
| `npm run backend:doctor` | BOOT-01 | 报告Node/npm/Docker/工具版本与锁定兼容性，输出不包含secret |
| `npm run backend:deps:test` | BOOT-02 | 仅创建隔离PG/Redis/S3模拟服务，绑定loopback非生产端口，幂等启动 |
| `npm run backend:test:guard` | BOOT-02 | 明确拒绝生产host/database/user及旧file数据库；不可用时fail closed |
| `npm run backend:typecheck` | BOOT-02 | 检查所有backend工作区，无emit |
| `npm run backend:lint` | BOOT-02 | lint+依赖边界检查，不自动重写文件 |
| `npm run backend:contracts:generate` | BE-01 | 无公网监听/生产连接，生成OpenAPI和TS SDK |
| `npm run backend:contracts:check` | BE-01 | 生成无diff、schema校验、兼容性、Swift fixture验证 |
| `npm run backend:test:unit` | BOOT-02 | 纯测试/fake ports，不接外部AI |
| `npm run backend:test:integration -- --suite <name>` | BOOT-02+各BE | 经guard创建本次测试数据库、独立测试身份，运行并清理，失败也保留脱敏证据 |
| `npm run backend:test:chaos -- --suite <name>` | OPS任务 | 独立stack故障注入，目标不明确拒绝执行 |
| `npm run backend:db:validate` | BE-02 | 校验PG schema和迁移一致；仅测试连接 |
| `npm run backend:db:test:migrate` | BE-02 | PG空库迁移+升级样本+constraints验证，由隔离runner执行 |
| `npm run backend:build` | BOOT-02 | 构建API/worker/scheduler，不修改DB |
| `npm run backend:migration:rehearse -- --manifest <path>` | 03数据库任务 | 必须显式只读快照及测试目标；ETL+对账+附件manifest，无生产默认值 |
| `npm run backend:load:seed -- --profile target --run-id <id>` | 05性能任务 | 只在性能测试数据库生成test_租户数据，保证可清理 |
| `npm run backend:load:test -- --profile target --run-id <id>` | 05性能任务 | 独立k6启动，输出按场景分组统计和throughput，不访问真实AI |
| `npm run backend:evidence:check -- --task <id>` | BOOT-02 | 检查任务要求产物存在且无secret，不代替人工review |
| `bash ../growdesk-ios/scripts/test-ios.sh --unit` | IOS基础任务 | 确定scheme/模拟器，运行核心测试，xcresult存evidence |
| `bash ../growdesk-ios/scripts/test-ios.sh --ui` | IOS测试任务 | 只连隔离后端，test_账户；截图/xcresult和测试环境标识 |
| `bash ../growdesk-ios/scripts/generate-api.sh --check` | IOS基础任务 | 从已验收OpenAPI生成客户端，无diff并编译；禁止手改生成代码 |

脚本不得偷偷source生产`.env`。测试runner给每run生成确定资源前缀、manifest和清理范围，连接后检查`current_database/current_user`及测试标识；生产runtime角色没有创建测试库权限，测试角色没有生产访问权。`NODE_ENV=test`或数据库名称含test都不能单独作为安全保证。

## 4. 依赖与Review门禁

```text
BOOT-01 → BOOT-02 → BE-01 → BE-02                 [G1 基础与契约]
                         ├→ BE-03 身份 → BE-04 家庭
                         └→ BE-05 事务记录
BE-04 → BE-08A 通用持久任务 ─┬→ BE-06 同步(另依赖BE-05/07) [G2 数据可靠性]
                            └→ BE-08B AI运行/SSE(另依赖BE-07附件)
BE-04/05 → BE-07 附件；BE-08B → BE-09 AI工具          [G3 后台与权限]
BE-05/07/09 → BE-10 领域全量 → BE-11 MCP兼容 → BE-12 Web适配 [G4 后端完整]
BE-01/G2 → IOS任务可并行 → 全部04对照功能完成           [G5 原生完整]
BE-02 → 03迁移演练（开发期持续）
G4/G5 + 03全量对账 + 05压测/故障/真机               [G6 发布候选]
G6 → 数据切换/渐进放量/真实监测                     [G7 生产接受]
```

依赖说明：BE-05可使用测试principal验证纯事务，但对外开放必须等BE-03/04；G2必须两条链路都完成。IOS初期使用contract fixture并行，不能以mock验收替代真实API联调。数据库ETL前期在副本演练，真实切换仅G6后。

G1/G2/G3/G6必须由独立review检查具体代码/测试证据。较弱Agent按小任务实现；昂贵review集中在不变量、跨模块集成和里程碑，不必逐按钮介入。

## 5. 核心后端任务卡

### BOOT-01：锁定工具链与证明选型组合可运行

- 输入：01技术栈、现有package/lock、AGENTS、当前HEAD。
- 输出：`TOOLCHAIN.md`、兼容性最小实验及脱敏日志；正式版本锁定清单。
- 步骤：①记录本机与CINode24/Xcode版本；②在隔离scratch验证Fastify5+TypeBox+swagger导出；③同一schema生成Swift客户端并编译nullable/decimal/discriminator样例；④Prisma7 adapter-pg连隔离PG18完成事务/unique/rollback；⑤BullMQ5连接Redis8提交一条无副作用任务；⑥锁精确版本与镜像digest。
- 验收：在干净checkout按文档可复现；没有依赖floating latest；没有真实AI/生产连接。
- 禁止：编译失败时改为any/手写第二套DTO；未经实验就散布版本到整个工程。

### BOOT-02：工作区、隔离环境和CI骨架

- 前置：BOOT-01。
- 输出：backend工作区、基础scripts、测试服务compose、testkit、CI分离job。
- 步骤：①核对现有 growdesk-server npm workspaces 与 @growdesk/* 包，补齐缺失文件并建立独立 lockfile，不搬旧 Web；②配置TS strict与单向导入规则；③建立隔离PG/Redis服务、独立账号与run database；④实现环境guard与正反测试；⑤CI使用Node24运行backend构建，旧 Web 保持独立仓库和 CI；⑥编写`evidence`规范和doctor。
- 验收：故意给生产样式URL、旧SQLite file URL、未知host、错误DB账号均在建立业务连接前拒绝；正确测试库启动/失败清理正常；干净checkout不依赖本地secret。
- 禁止：把根`.env.test`改指生产PG；旧测试规范在替代runner验证前仍生效。

### BE-01：契约与SDK流水线

- 前置：BOOT-02；输入02 §2/§3/§4/§5/§6以及04矩阵。
- 输出：TypeBox schemas、OpenAPI、fixture集合、生成检查；完整endpoint inventory（implemented=false起步）与逐字段`contracts/FIELD_MAPPING.md`（格式见02 §10）。
- 步骤：①建立通用ID/date/decimal/error/page schema；②定义登录和feeding/sync/run最小完整契约；③注册route metadata导出；④生成TS/Swift并测异常fixture；⑤增加breaking-change检查；⑥逐领域补齐契约后才允许对应实现。
- 验收：没有TS/Swift各自猜nullable与枚举；所有operationId稳定；错误响应可解码；未实现endpoint不得返回假数据。

### BE-02：PostgreSQL基础模型、UnitOfWork与索引

- 前置：BE-01；输入03数据分类和02新模型。
- 输出：独立PGschema/migrations、runtime/migration/test角色、repositories/UnitOfWork、schema说明。
- 步骤：①从旧model逐个映射并保持ID；②建约束/index/version/soft delete；③新建会话、feed、outbox等表；④加Family/User state锁API；⑤所有SQL参数化；⑥测试迁移空库/升级、FK跨家庭拒绝、transaction回滚。
- 验收：03模型manifest无漏项；业务事务使用同一个tx client；runtime不是超级用户/owner；迁移SQL不复用SQLite历史；重复运行迁移不会重建已有数据。
- 禁止：直接`db push`目标库；创建一个全能JSON记录表替代领域schema。

### BE-03：首方身份与设备会话

- 前置：BE-02；输入02 §3。
- 输出：register/login/refresh/logout/me/sessions/password/recovery-codes、principal plugin、Keychain对应fixture。
- 步骤：①保留bcrypt兼容并限制hash并发；②实现JWT claims+device验证；③原子refresh轮换与60秒同rotation恢复；④session撤销/重放保护及一次性恢复码；⑤限流与错误不枚举；⑥写并发/丢响应/旧token/未知算法/恢复码重复消费测试。
- 验收：B-12通过；MCP token不能调用v1；session撤销后旧access立即拒绝；测试日志不出现token/password。
- 禁止：仅生成7天JWT而不实现刷新；app保存client secret；关闭audience校验兼容旧代码。

### BE-04：家庭、宝宝、角色与删除归属

> 新增必读 [08 账号与宝宝多对多](08_ACCOUNT_BABY_RELATIONSHIPS.md)。必须实现显式 BabyMember；家庭管理与宝宝数据权限分离。验收必须包含一人多宝宝、同宝宝多人、同家庭只授权部分宝宝、撤销单个关联不影响其余照护者，以及删除账号不级联共享宝宝。

- 前置：BE-03；输入01 §7/8、02 §3.3。
- 输出：家庭列表/邀请/成员/宝宝/权限策略及导出删除状态机基础。
- 步骤：①角色矩阵写成测试表；②邀请码hash/有效期/爆破保护；③宝宝显式列表；④角色撤销同事务锁和UserChange；⑤最后admin保护；⑥定义个人删除与共享record匿名化；⑦验证所有新接口的跨家庭攻击。
- 验收：两家庭、两角色、多宝宝fixture全路径隔离；不使用findFirst隐式首宝宝；删除个人不会抹掉另一照护者共享记录。

### BE-05：统一记录事务入口（按一种记录一个子任务）

- 前置：BE-02，公开路由需BE-04；输入02 §4/§8。
- 输出：feeding→diaper→sleep→foodLog→supplement→growth的command handlers、TimelineEntry、snapshot/feed/outbox/receipt。
- 步骤：①先为feeding实现完整create/update/delete/restore；②实现事务幂等与version；③写B-01~05；④复制的是测试和service骨架，按每类输入复用golden规则；⑤加入睡眠依赖状态与唯一活跃约束；⑥领域记录的来源和产品历史快照。
- 验收：每类记录都通过故障回滚和双写冲突；push失败不会让record响应假失败重记；TimelineEntry对账一致。
- 禁止：只实现create后把update/delete留TODO；HTTP、AI、MCP分别写三套Prisma逻辑。

### BE-08A：先建立通用持久任务基础（在BE-06前执行）

- 前置：BE-02/04，不依赖附件、AI或同步快照。
- 输出：TaskExecution/TaskOutbox持久执行头、dispatcher、worker领取/续租/fencing、reconcile和fake无副作用processor。
- 步骤：①定义公共任务状态/结果；②PG事务outbox到BullMQ；③固定jobId与PG条件领取；④心跳与过期恢复；⑤Redis清空、旧worker恢复、重复投递测试；⑥提供snapshot/export/delete/AI都可注册的processor接口。
- 验收：无任何模型或附件也能证明队列丢失可重建、旧fence拒绝写、完成结果原子提交；公共状态只存TaskExecution一次。
- 禁止：让snapshot等待BE-09真实AI；不同领域再建第二套队列或lease。

### BE-06：同步feed、bootstrap和边界恢复

> 结合 08 按当前 BabyMember 权限生成快照和 feed 投影；家庭级绑定通过不代表全部宝宝可见。增减宝宝授权时的权限版本、缓存撤销和快照重建必须有真实并发与恢复测试。

- 前置：BE-04/05/07/08A；输入02 §5。BE-07提供S3适配器和私有下载基础，snapshot有自己独立scope，不复用用户上传权限。
- 输出：family/user change API、签名cursor、snapshot worker及下载协议、retention清理。
- 步骤：①FamilyState锁顺序并发测试先写；②有界highWater分页；③Repeatable Read snapshot分页面+hash；④快照切换与追赶fixture；⑤90天retention/410/epoch重建；⑥撤权、bootstrap中写入和跨scope cursor测试。
- 验收：B-07/08/09通过；同一时刻PG projection与模拟客户端按ID/version一致；游标不能跳过未返回页；大家庭不OOM。
- 禁止：只按updatedAt同步；用普通sequence当提交cursor；snapshot跨多个不一致事务拼起来。

### BE-07：私有附件与历史URL映射

- 前置：BE-04；输入02 §7和03附件清单。
- 输出：Attachment模型service、S3 adapter、init/complete/read/delete接口和迁移映射。
- 步骤：①owner scope与引用模型；②限制上传key/size/type；③完成校验hash/魔数；④受保护流式下载与背压；⑤孤儿清理；⑥旧URL有鉴权映射和静态绕过测试。
- 验收：B-06；恶意MIME、超限、未完成对象、他人URL拒绝；大文件内存有界；旧医学图片不再公开可取。

### BE-08B：AI run聚合、持久事件与SSE恢复

- 前置：BE-04/07/08A；输入02 §6。
- 输出：AiRun关联公共TaskExecution、event、fake AI processor、SSE和确认状态；复用08A，不重复存状态。
- 步骤：①先用fake provider实现完整run终态；②接08A的事务outbox→Redis；③复用lease/fence并补AI cancel/retry；④持久事件与Last-Event-ID；⑤慢连接限制；⑥worker/Redis故障注入。
- 验收：B-10/11/13（工具先用最小测试动作）；API断开任务继续；部署重启后任务终态可见；旧worker不能写新attempt。
- 禁止：用Node未等待Promise代替worker；在一个大事务里等模型；只测试正常结束。

### BE-09：真实AI适配、工具确认、语音/OCR/日报

- 前置：BE-05/07/08B；输入旧lib/agent+02 §6/7。
- 输出：provider adapter、usage/budget、工具计划与确认、OCR/voice/daily-summary processors。
- 步骤：①移植模型适配保持golden；②读工具接scoped服务；③写工具预览+planHash+action幂等；④OCR草稿确认；⑤语音受控转录和结构化记录；⑥日报时区/版本/唯一性；⑦fake供应商超时429错误/乱序测试后，单独限额真实供应商smoke。
- 验收：B-09/10/16；取消不伪称撤回已写；权限/预算拒绝不发收费调用；失败无假数据；真实smoke证据与mock测试分列。
- 禁止：写工具直接prisma.delete({id})；重新发整个对话历史当权威；无限重试模型请求。

### BE-10：全领域与通知、数据管理

- 前置：BE-05/07/09；输入04全量矩阵。
- 子任务：nutrition产品/计划/分析；WHO/growth；疫苗；发育/食材/绘本/活动/天气；报告；通知/APNs；个人导出删除；语音历史/已读；GET `/me/ai-usage`聚合。BE-10负责这些管理与查询验收，不能遗漏无独立页面的能力。
- 每子任务步骤：①旧输入/输出golden；②新service/repository；③v1 route；④家庭/个人scope错误用例；⑤边界单位/时区；⑥索引/分页；⑦在矩阵勾选实现+证据而非只写done。
- 验收：全字段映射明确；远程provider失败不阻断日常数据；APNs拒绝/token变更/跨账号解绑通过；导出可读，删除可追踪，备份恢复不复活删除数据。

### BE-11：MCP/OAuth/PAT兼容迁移

- 前置：BE-03/04/05/09；输入旧工具枚举、OAuth discovery和usage归因测试。
- 输出：新Fastify MCP/OAuth adapter、旧客户端协议fixtures、凭证迁移策略；GET/DELETE `/connections`与GET/POST/DELETE `/me/tokens`由BE-11负责实现。PAT只首次返回明文、scope/过期/撤销与跨用户拒绝为验收项。
- 步骤：①逐工具对照名称/参数/结果；②授权scope最小化/refresh不得扩大；③工具委托domain；④atomic-batch全回滚和undo；⑤归因保留；⑥对外协议回归（mock客户端+实际授权smoke分别记录）。
- 验收：现有依赖MCP的调用方式有映射；OAuth code单次并发验证；撤销后工具拒绝；外部OAuth token不被接受为App token。
- 禁止：为兼容临时跳过PKCE/aud；把atomic batch实现成Promise.all部分成功。

### BE-12：Web兼容和旧写入口退休

> 2026-09-12 执行拆分补充：[09共享后端计划](09_WEB_IOS_SHARED_BACKEND.md)允许提前实施隔离环境的Web兼容层与单领域联调；本节完整功能、迁移演练及正式切换前置保持不变。

- 前置：BE-10/11、03至少一次演练。
- 输出：兼容route字段映射表、Web API SDK/同源路由、旧DB调用禁止检查。
- 步骤：①保留Next页面，UI通过新API；②必要server components通过服务API取数；③保持cookie/CSRF转换在Web边界；④旧API字段兼容映射；⑤停旧定时任务/stdio直连DB并改新服务；⑥架构扫描生产可达代码不得再连SQLite或旧全局prisma。
- 验收：旧Web Playwright流程在PG后端通过；iOS/Web/MCP写入相互可见；只有一个生产写权威。
- 禁止：双写SQLite/Postgres作为长期方案；仅切iOS API但Web/MCP仍写旧库。

## 6. 原生、迁移、运维任务如何领取

04中的IOS任务、03中的DB任务和05中的OPS任务与上述任务是同一个backlog的专项任务。它们不能跳过相关门禁：

- IOS基础工程/契约fixture可在G1后并行；离线真实联调等G2；AI恢复等G3。
- DB清单/只读审计可立即开始；PG导入脚本依BE-02；最终切换等G6。
- OPS基础CI/容器可跟BOOT并行；真实性能基准等BE-10/IOS联调；生产部署等G6。
- 每个专项任务必须在自己的任务卡登记此依赖，不允许多个Agent同时改同一个schema、OpenAPI或migration目录。

推荐并行最多三条：①身份/数据库/同步主线；②基于冻结契约的原生界面；③迁移脚本/测试/运维。schema与contracts指定一个Owner串行整合。别把“多人并行”变成三个不同版本协议。

## 7. 每任务交付格式（实现Agent必须填写）

在`evidence/tasks/<TASK-ID>/REPORT.md`写：

```text
任务：
状态：IMPLEMENTED_NOT_REVIEWED / BLOCKED（不能自行写ACCEPTED）
基线HEAD / 完成HEAD或diff定位：
依赖门禁与证据：
允许范围 / 实际改动文件：
行为变化：用一个具体输入说明前后结果
契约/schema变化：无 / 具体内容及批准的ADR
验证命令：逐条原始命令、退出码、时间、测试环境标识
自动测试证据路径：
真机/hosted/provider证据：有则链接，没有就写未验证
失败及未解决项：
迁移/回退影响：
交给reviewer最应检查的3处：
```

最低证据：改动diff、相关自动测试输出、失败路径证据、schema/契约diff（如有）。UI额外截图索引/设备系统/操作路径；性能额外k6原始JSON、资源图、SQL计划、硬件和commit；迁移额外manifest、逐表count/hash、invalid报告和附件checksum。

evidence不得包含真实宝宝记录、secret、原始病历或长期签名URL；可用test_合成数据，生产数据对账仅留计数/hash等受控脱敏结果。

## 8. 可直接复制的实现提示词

```text
请仅实现 Baby Panel 迁移计划中的 <TASK-ID>。
仓库：/Users/wangzhuo/Documents/GitHub/growdesk-server（IOS 任务改为同级 growdesk-ios）
旧 Web 只读参考：/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia
计划入口：/Users/wangzhuo/Documents/GitHub/growdesk-server/docs/plan/IOS_MIGRATION_PLAN.md
任务手册：/Users/wangzhuo/Documents/GitHub/growdesk-server/docs/plan/implementation/06_AGENT_EXECUTION_PLAYBOOK.md

先读适用AGENTS、该任务卡和它引用的规格章节；检查当前HEAD和dirty文件。
本次允许修改：<按任务填写目录/文件>。
依赖已接受：<填写门禁/commit/证据，不知道则先核对>。
核心技术栈已固定，不要自行换库、框架或同步/鉴权方案。

先写一个简短实施检查单，然后完成任务、运行相关隔离测试、检查diff。
测试只能使用隔离PostgreSQL/Redis及test_/e2e_账户，不连接生产。
不得用mock替代本任务正在验证的持久化、权限、并发或事务行为。
发现规格冲突/依赖未完成时报告具体阻塞，不绕过、不扩展范围。
完成后按模板生成evidence/tasks/<TASK-ID>/REPORT.md。
状态只能写IMPLEMENTED_NOT_REVIEWED；不要声称整个迁移完成，不部署或push。
```

任务执行中的普通可逆修复无需反复请示；真正需要用户/架构决定时给出已有证据、受影响条款和两个具体选项。不要问“要不要继续”来结束半成品任务。

## 9. 可直接复制的Review提示词

```text
请独立review Baby Panel 的 <TASK-ID / GATE-ID>。
基线：<commit>；待审：<commit/branch/working diff>。
计划：/Users/wangzhuo/Documents/GitHub/growdesk-server/docs/plan/implementation/ 对应规格和任务卡。
证据：evidence/tasks/<TASK-ID>/REPORT.md（不能直接相信报告结论）。
优先检查：越权/串号、事务原子性、幂等与重试、cursor提交顺序、
凭据撤销、worker重复执行、数据迁移损失及协议兼容。
检查实现是否真的覆盖任务范围；必要时在隔离环境重跑最关键失败场景。
每个问题给严重度、具体触发条件、代码位置、影响和最小修复建议。
区分：代码缺陷、证据缺口、规格需要决定；没有证据不得声称线上已验证。
输出PASS / CHANGES_REQUIRED / BLOCKED及下一步允许开始的任务。
```

## 10. 全量完成判定和工期管理

只有同时满足下列条件，才称“迁移完成”：04所有既有功能映射验收；02不变量通过；03数据与附件对账/恢复演练通过；05性能/安全/真实设备通过；旧生产写入口退休；发布后监测达到G7时长。README、代码生成、首页跑起来、mock展示或大量代码行数都不是完成标准。

不沿用之前7–11.5周的估算：本轮增加完整后端拆分、PostgreSQL转换、全离线编辑/冲突、持久任务和系统级验收。初步按**20–32人周**工程量预算（含实现、联调、复审返工，不含审核等待）；单人兼职/较弱Agent会更久。可并行的两条有效开发线可缩短日历时间，但权限/同步/迁移门禁不可省。

第一批只领取BOOT-01、BOOT-02、BE-01，完成后依据真实返工率和吞吐重新估算。费用控制优先缩小单任务上下文、复用fixture和测试脚本、集中review，而不是让一个Agent一次生成全部代码后再花大成本找错。

## GrowDesk 独立仓库交接补充（路径调整）

服务端 schema/export 归 growdesk-server；IOS01 消费已验收导出，在 growdesk-ios 的 `Contracts/openapi.json` 固定快照，并用 `Contracts/source.json` 记录源仓库、commit、契约版本与 SHA-256。生成客户端及 CI 只读取该快照，不依赖相邻目录或浮动分支。契约变更分别记录两仓库 commit 和验证结果；不维护第二套手写 DTO。BOOT/BE/DB/OPS 在服务端实施，IOS 在原生仓库实施；BE-12 涉及旧 Web 的部分须单独限定修改范围并提供该仓库的 diff/证据。详细入口见 growdesk-server 根 START_HERE.md。
