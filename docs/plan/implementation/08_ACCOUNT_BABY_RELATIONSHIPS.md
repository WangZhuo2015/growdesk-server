# 08 — 账号与宝宝的多对多关系（执行规格）

状态：已确定关系与授权边界，待 BE-02/BE-04 落地 PostgreSQL 表、迁移和端点。本文件不代表数据库或 API 已实现。

## 1. 决策与边界

- 一个账号可以属于多个家庭，也可以在同一个或不同家庭中关联多个宝宝；一个宝宝可以有多个照护者。
- `Family` 是分组、租户和同步 cursor 的容器，不是宝宝数据的授权替代物。账号的家庭关系和宝宝关系分别持久化。
- 不使用 `activeBabyId` 表示归属或权限。客户端当前选中的宝宝只是导航状态，服务端每次按请求中的 `familyId + babyId` 读取当前关系。
- 家庭 admin 只自动拥有家庭管理权限，不自动获得家庭内任何宝宝的记录读取、写入或宝宝成员管理权限。
- 可选云同步的 `CloudSyncBinding` 只证明绑定、设备、generation 和家庭级同步门禁；它不能代替本文件的逐宝宝授权。同步、快照、附件、MCP 和 family feed 都必须再次检查宝宝关系。

## 2. 关系模型

| 对象 | 必要字段 | 语义 |
|---|---|---|
| `Family` | `id` | 分组/租户容器；不因某个用户退出而隐式删除共享宝宝 |
| `Baby` | `id`, `familyId` | 宝宝属于一个家庭；数据库保留唯一键 `(familyId,id)` |
| `FamilyMember` | `userId`, `familyId`, `role`, `status` | 独立的家庭成员和家庭管理权限；role 为 `admin/member/viewer` |
| `BabyMember` | `userId`, `babyId`, `familyId`, `role`, `status` | 显式的账号—宝宝授权；role 为 `admin/member/viewer`，status 至少为 `invited/active/revoked` |

`BabyMember` 必须有复合外键 `(familyId,babyId)` 指向 `Baby(familyId,id)`，并建立唯一约束 `(userId,babyId)`。写入前还要校验 `BabyMember.familyId === Baby.familyId`；不能只按 `babyId` 查找后相信客户端提供的家庭。账号退出或删除只撤销/删除该账号的 `FamilyMember`、`BabyMember` 和私人数据，不能 cascade 删除共享 `Baby` 或共享记录。

实现时至少为 `BabyMember(familyId,babyId,status)`、`BabyMember(userId,familyId,status)`、`Baby(familyId,id)` 和宝宝记录的 `(familyId,babyId,createdAt,id)` 建立查询索引；`(userId,babyId)` 唯一约束同时承担去重。宝宝目录和 family feed 使用带稳定排序键的服务端 keyset 分页，查询只取当前页和授权联结结果，不能把全家庭宝宝或记录加载进应用内存后再过滤。

家庭和宝宝可以有相同的 role 名称，但它们不是继承关系。家庭 admin 若要读取某个宝宝，仍需一条该宝宝的 active `BabyMember`；宝宝 admin 也不因此成为家庭 admin。

## 3. Principal 与运行时授权

登录凭据只建立已验证的 `UserPrincipal`。宝宝权限不能塞进长期 JWT，也不能从客户端提交的 `activeBabyId`、`userId` 或 `familyId` 推断。处理记录、附件、同步和 feed 的事务必须：

1. 从已验证 session/Bearer 得到 `principal.userId`，并在事务中读取目标 `Baby`、当前 `FamilyMember` 和 `BabyMember`。
2. 确认当前 `FamilyMember.status=active` 且 `familyId` 匹配。
3. 确认 `(principal.userId,babyId,familyId)` 的 `BabyMember.status=active`，再按宝宝 role 判断动作。
4. 对记录行再次确认 `record.familyId`、`record.babyId` 与目标宝宝一致；权限结论不能在等待锁前缓存后继续使用。

`BabyAccessContext.loadedBaby` 必须是同一事务重新读取并校验过的 `Baby` 行；请求体中的 ID 只能作为查询范围，不能直接成为授权依据。策略拒绝必须发生在业务写入或序列化之前，且读取、写入、feed、同步和 MCP 各入口都要走同一宝宝级检查。

领域层提供 `authorizeBabyAccess` 和 `BabyAccessContext`。`read` 需要 active family + active baby membership；权限取家庭成员资格与宝宝成员资格的交集：`write` 同时要求家庭 `admin/member` 和宝宝 `admin/member`，`manage`（邀请、撤销、角色变更）同时要求家庭 `admin/member` 和宝宝 `admin`。因此家庭 `viewer` 即使是宝宝 `admin` 也只能读取，不能写入或管理；家庭 admin 也必须有该宝宝的 active `BabyMember`。`canViewFamily` 只表示可以看到家庭容器元数据，不能被记录查询或 feed 当成全宝宝授权。旧的只接收 `familyId` 的 `canWriteRecord` 形态不再作为记录授权入口。

`FamilyMember` 被撤销后，即使旧的 `BabyMember` 行尚未清理，当前家庭资格检查也必须立即拒绝访问；同一事务应将该家庭下关系标为 revoked 并递增权限版本。单独撤销某个 `BabyMember` 不影响该账号在同家庭其他宝宝上的 active 关系。

## 4. 邀请、撤销与最后管理员

- 家庭邀请只创建/更新 `FamilyMember`，不自动授予家庭内全部宝宝。宝宝邀请必须绑定不可变的 `(familyId,babyId)`，由该宝宝的 active admin 发起；验证码、过期时间、撤销状态和目标范围在服务端保存，不能接受客户端改 scope。
- 接受宝宝邀请在一个事务中重验邀请、账号、家庭成员资格和宝宝归属，再幂等 upsert `(userId,babyId)`。用户可保留家庭成员资格但只看到被邀请的宝宝。
- 撤销或降级宝宝成员时，必须锁定家庭状态并重新读取当前成员；不能撤销/降级最后一个同时拥有当前家庭 `FamilyMember.status=active` 且家庭 role 为 `admin/member` 的 active baby admin。仅有 `BabyMember.role=admin` 但其家庭成员已是 `viewer` 或 `revoked` 的候选不计入保护条件。家庭成员降级也必须在同一锁内重验这个不变量；先显式转移另一个可管理的宝宝 admin，再执行原操作。
- 撤销家庭成员时，家庭内所有宝宝访问都应失效，并产生权限版本变化；其他家庭中的同一账号关系不受影响。
- 删除账号不会删除共享宝宝或共享记录。共享记录作者匿名化、私人会话和凭据清理由账号删除流程另行处理；不能因为删掉最后一个照护者而留下可被默认删除的宝宝。

## 5. Family feed、快照与权限版本

家庭 feed 中每一条宝宝记录都带 `familyId + babyId`。数据库查询必须先按当前 active `FamilyMember` 与 active `BabyMember` 联结过滤，并使用 `FamilyChange(familyId,cursor)` 的提交顺序索引支持 feed 分页后再序列化；宝宝关联查询使用 `(userId,familyId,status,babyId)`，记录时间轴另用 `(familyId,babyId,occurredAt,id)` 索引，不能用 createdAt 替换 feed cursor；不得先把家庭全量记录加载进内存、返回宝宝名称/时间等元数据，再在客户端隐藏无权宝宝。家庭级元数据可以按家庭成员资格返回，但不能携带未授权宝宝正文或存在性信息。

权限变更递增家庭的 `permissionVersion`（实现时可落在 `FamilySyncState` 或等价的权限状态行），并使对应缓存、快照和 feed 游标失效。签名 cursor 至少绑定 `familyId`、`principal.userId`、权限版本和位置；版本不一致时要求重新建立受当前宝宝权限过滤的分页/快照。旧 cursor 不能在撤权后继续读取，也不能借 cursor 推断被撤销宝宝的变更。

所有家庭写事务继续遵守现有锁顺序：`UserSyncState(按 userId 排序) → FamilySyncState(按 familyId 排序) → DeviceSession → RefreshCredential/RecoveryCode → TaskExecution → 业务实体`。涉及家庭/宝宝记录时，取得 `FamilySyncState` 后重验 `FamilyMember`、`Baby`、`BabyMember` 和目标记录，再写实体、timeline、change/outbox；网络调用不能持有这些锁。多家庭操作按 `familyId` 排序，禁止另造宝宝级锁顺序。

## 6. 旧数据回填与新建默认值

旧系统只有 `FamilyMember` 时，把 `FamilyMember JOIN Baby ON Baby.familyId = FamilyMember.familyId` 的每个 `(userId,familyId,babyId)` 组合显式回填为一条 `BabyMember`；旧行没有 status 时，经过迁移确认的有效旧成员映射为 `active`，不能复制一个不存在的字段。使用 `(userId,babyId)` 幂等 upsert，并保存回填批次、来源和无法判断的行。这样能保持旧账号对旧家庭内现有宝宝的访问，同时不引入 `activeBabyId`。回填完成前，服务端不得把“有家庭成员行”当作新模型的永久授权旁路。

新建家庭不会隐式创建宝宝；新建宝宝与明确指定的初始照护者 `BabyMember`（通常是创建者的 baby admin 行）在同一事务原子创建。家庭中其他 admin/member 必须通过宝宝邀请或显式成员操作加入。之后的家庭成员变更不能静默扩展宝宝范围。

本任务只冻结模型、回填规则和纯权限策略；不创建 Prisma schema、迁移 SQL、HTTP/MCP 端点或假数据。BE-02/BE-04 必须补齐复合 FK、唯一约束、索引、权限版本和并发事务证据。

## 7. 最小验收用例

- 一个 `test_` 账号在两个家庭分别拥有不同宝宝关系；两个照护者共享同一宝宝；没有全局“当前宝宝”字段也能独立授权。
- 家庭 admin 没有 `BabyMember` 时，读取、写入、邀请和 family feed 中该宝宝均被拒绝。
- viewer 可读指定宝宝但不可写/管理；`invited`、`revoked` 的关系不能访问；缺少 `babyMemberships` 的旧 principal 对记录访问 fail closed。
- 请求的 `familyId`、`babyId` 与事务中重新读取的 `Baby` 或 `BabyMember` 不一致时，在业务写入或序列化前拒绝；同一 `userId,babyId` 的重复关系被唯一性检查拒绝。
- family feed 只返回当前有权宝宝；撤销/降级最后一个 baby admin 被拒绝，有另一个 active admin 才能完成；撤销一个宝宝不影响同账号的其他宝宝/家庭。
- 旧 FamilyMember 回填后旧访问保持，账号删除保留共享宝宝；权限版本变化后旧 cursor/快照不能继续读取无权宝宝。
