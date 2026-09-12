# BOOT-01 修复版独立 Review

日期：2026-09-11。结论：**CHANGES_REQUIRED**，BOOT-01 暂不标 ACCEPTED。

## 范围与基线

审查当前修复版 `TOOLCHAIN.md`、scratch/boot01、相关 package/.gitignore 和任务证据，对照计划 06 的 BOOT-01 与 AGENTS。仓库 main 尚无提交（UNBORN），不能用 HEAD 三点 diff；本次以当前初始交付工作树为审查对象，文件哈希见同目录 SOURCE_MANIFEST.json。原有计划/骨架作为上下文，不把 BOOT-02 以后业务尚未实现列为本任务缺陷。本次只新增 review 报告/证据，没有修改实现。

## Standards：工程规范与安全

### S1 [P1] 测试脚本不能证明所连接实例属于本次隔离环境

位置：`scratch/boot01/prisma-pg-check.ts:15–24`、`scratch/boot01/infra-test-env.sh:17–26`。

PG guard 只检查 loopback 和路径包含 `test_`，不限制数据库全名、角色、端口或本次实例身份；随后执行 DROP/CREATE TABLE。启动脚本遇到已监听的 PG/Redis 端口直接认作就绪，未校验实例所有权。于是端口被其他实例/隧道占用，或传入 `postgresql://admin@localhost:5432/production_test_archive`，仍会越过 guard 进入连接/写入阶段。localhost 和名字包含 test_ 均不等于物理隔离。AGENTS 明确要求 host/database/role 的允许列表及测试/生产隔离。

最小修复：由 runner 分配独立 run 目录、端口、测试角色/数据库和实例标识，向子进程传入完整允许配置；连接前严格比对，端口占用时失败而非接管。只有本次创建且身份匹配的进程可以清理。补充错误角色、错误端口、伪 test 名称、已有监听实例的负向测试，证明未发生业务连接/DDL。此次没有用危险目标做动态探测；独立 PG 复测改用 reviewer 自建随机端口临时集群。

### S2 [P2] 在 guard 之前打印完整数据库 URL，会泄漏被拒绝连接的密码

位置：`scratch/boot01/prisma-pg-check.ts:12`。

使用纯合成 URL `postgresql://test_user:SYNTHETIC_REVIEW_PASSWORD@example.invalid/test_review` 运行时，脚本退出 1，但 stdout 已包含完整密码。非允许主机在连接前被拒绝，复现未建立网络连接。真实 CI 如传入带密码的测试 URL，会把密码写入日志；违反 AGENTS 的证据脱敏要求。

最小修复：先校验，日志仅保留允许公开的 host/port/database，不输出 username/password/query；异常也脱敏。增加合成 secret 字符串不得出现在 stdout/stderr 的断言。

## Spec：任务要求与实际交付

### P1 [P1] “锁定版本”清单不是实际验证的依赖版本

位置：`TOOLCHAIN.md:23–35`，对照 `scratch/boot01/package-lock.json`。

| 组件 | 文档锁定 | lockfile 实际 |
|---|---|---|
| Fastify | 5.2.1 | 5.12.4 |
| TypeBox provider | 5.1.0 | 5.2.0 |
| Swagger | 9.4.2 | 9.8.1 |
| Prisma Client | 7.5.0 | 7.10.0 |
| pg | 8.13.3 | 8.23.0 |
| BullMQ | 5.41.6 | 5.81.5 |
| TypeScript | 5.8.2 | 5.9.3 |
| tsx | 4.19.3 | 4.23.13 |

BOOT-01 的核心验收是锁定经实验验证的版本、干净 checkout 可复现。后续 Agent 按文档创建正式后端将使用未经本次实验证明的另一组版本。当前 package.json 已改为精确版本，但 lockfile 根元数据仍保留旧范围且解析版本未同步；不能直接拿现有 node_modules 的通过结果证明新 manifest 可安装。问题不是 semver 范围本身，而是文档、manifest、lock 与验证对象不一致。仓库也没有完整的干净环境复现步骤（npm ci、Prisma generate、生成契约到 Swift 输入、服务启动/失败清理的顺序），已声明的 `backend:doctor` 指向尚不存在的脚本。

最小修复：选择实际验证版本并统一清单与 lock，补充可复制的 bootstrap/doctor；从不包含 node_modules/.build 的临时源码副本完整跑一遍，保留日志。镜像 digest 已写入，但本轮未验证镜像拉取/容器运行，不能把 Homebrew 运行结果称为容器验证。

### P2 [P2] 示例错误契约在真实请求上返回 500，现有 Swift fixture 测试掩盖差异

位置：`scratch/boot01/fastify-typebox-swagger.ts:219–222`，以及 buildFastifyApp 未注册匹配 envelope 的错误处理。

独立 `app.inject`：`POST /sample/timeline`，payload `{"kind":"bogus","id":"test_event"}`。实际 status=500，code=`FST_ERR_FAILED_ERROR_SERIALIZATION`，message 包含 `"code" is required!`。Fastify 默认校验错误与注册的 `ApiErrorEnvelope` 不匹配，导致本应是 400 的失败再次序列化失败。合法 feeding 请求和 nullable GET 均为 200。

最小修复：示例 app 增加与声明 schema 一致的校验错误映射；对实际 inject 的 400 输出做断言，并由同一响应生成/解码 Swift 测试数据。这里不要求提前实现 BE-03 的完整认证，只要求作为后续契约参考的最小实验自身正确。

### P3 [P2] 强制 exit(0) 不能证明 BullMQ 自然退出

位置：`scratch/boot01/bullmq-redis-check.ts:64–67`；任务 REPORT 的“自然退出”结论。

改为配置对象、close worker/queue/events 的方向正确，但成功分支仍调用 `process.exit(0)`。即使还残留连接/定时器，进程也会被强制结束，因此当前退出码不能支持“自然退出/无连接泄漏”的验收声明。不是断言当前必定泄漏。

最小修复：去掉成功路径强制退出，清理放 finally，由外层测试超时监控子进程自然终止；失败时正确清理并设置非零 exitCode。附实际自然退出证据后更新报告。

## 已修复与独立验证

- Prisma 假验证已修复：确实建立 PrismaClient + PrismaPg 并调用 `$transaction`。reviewer 新建独立 PG 18 临时集群、随机端口、test_ 数据库运行现有脚本；commit、P2002、rollback 全通过，exit 0。集群已停止并删除。
- `.gitignore` 已允许实验源码进入版本控制；仍是未提交文件，不能误称已提交。
- routes 的 union 已改 Type.Ref，导出 POST requestBody 指向 TimelineEvent；合法 feeding 请求与 nullable 响应通过。
- `swift test --disable-automatic-resolution`：4 项通过，exit 0。
- 当前安装 adapter 默认不销毁传入的 external pool；`prisma.$disconnect()` 后由调用者 `pool.end()` 在本版本是合理所有权安排，不列为双重关闭缺陷。
- Swift 版本清单与 OCI digest 文本已补充；本次未独立核验镜像内容。

## 证据与下一步

同目录保留 Swift 日志、隔离 PG 运行及清理日志、SOURCE_MANIFEST.json。运行测试依赖当前本机已有安装；未声称干净 checkout、CI、线上性能、生产迁移或真实 provider 已验证。未使用仓库中尚未证明安全的 infra start/stop 接管任何已有实例；本轮未重跑 BullMQ。

实现 Agent 先修 S1/S2 和 P1，再修 P2/P3；每项附失败场景与修复后结果，更新原任务报告，重新 review BOOT-01 后再接受其版本基线。可做无依赖的文档准备，但不要把 G1 当作已通过。

本轮主审：Standards 2 项（最高 P1）；Spec 3 项（最高 P1）。

## 并行复核摘录（独立视角）

**Standards reviewer**：发现连接 URL 泄漏、PG/Redis 实例所有权缺失、版本文档与锁不一致、BullMQ 强制退出掩盖自然终止证据；确认源码已不再忽略、Prisma 真实调用、OpenAPI Ref/oneOf 与 digest 文本已补齐。以上与主审 S1/S2/P1/P3 重合，不重复计数。

**Spec reviewer**：确认 BOOT-01 要求的 doctor 入口目标文件缺失，版本冻结仍不一致。发现 macOS 表格与日志平台字段不同，但 PostgreSQL 的编译目标不直接证明当前宿主版本；该项不单独定为缺陷，更新工具链清单时记录实际 uname 即可。

**额外验证限制**：在临时目录复制 manifest/lock 执行 `npm ci --dry-run --ignore-scripts --offline --no-audit --no-fund`，因本机缺 uuid registry 缓存而退出 ENOTCACHED（见 npm-ci-dry-run.log），没有完成干净安装验证；不能把该退出归因于版本不一致。未下载依赖或改动业务工作区。
