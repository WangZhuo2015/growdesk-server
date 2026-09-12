# BOOT-01 R3：复核与直接修复

日期：2026-09-11。结论：**本轮已列缺陷已修复，本地验证通过，可继续 BOOT-02；不代表 G1 全阶段或生产上线已验收。**

范围：当前 BOOT-01 工具链、契约最小实验及测试隔离；不包含后续业务功能、生产迁移或上线验收。仓库仍为 main / UNBORN，所有实现为未提交工作树。本次按用户授权直接修改剩余问题，保留 R2 报告与既有证据。

## 本轮确认并直接修复

| 问题 | 修复 | 验证 |
|---|---|---|
| guard 声明 allowedUser 但没有比较；可选 clusterDir 只检查文件存在；允许 URL query 改写实际连接参数 | 新增 test-environment.ts；必须由私有 run manifest 提供完整身份，URL 严格比较协议、host、port、database、role、临时密码，禁止额外 driver 参数。连接后核对 cluster token、数据库、非超级用户测试角色、PG18，再执行 DDL | 10 项正负向 guard 测试；真实错误 cluster token 被拒绝，表未创建 |
| 固定目录/端口可能复用其他实例，PID 文件不足以证明所有权，createdb 失败被吞掉 | run-isolated.py 管理一次性子进程：随机端口、私有临时目录、专用非超级用户角色、临时凭据、独立 Redis；不再接管/停止已有实例；所有退出路径清理 Popen 持有的子进程 | 端口占用测试证明外部 listener 存活；故意中断验证后所有子进程退出、目录清理 |
| 数据库错误路径仍可能暴露连接信息，DDL 出错时 pool 清理不完整 | 日志不输出 URL/密码；URL 解析失败返回固定错误；pool finally 覆盖连接、DDL、Prisma 测试全过程 | 合成凭据错误不回显；真实失败和正常事务验证 |
| BullMQ 仍依赖固定端口，资源清理若某个 close 失败会跳过其余资源 | 读取 runner 的临时端口和密码，run 独立队列；所有 close 使用 allSettled，失败以非零退出；成功不强制 process.exit | 实际任务完成、关闭连接，子进程自然退出 0 |
| Prisma adapter 与顶层 @types/pg 不一致，运行通过但 strict TS 编译失败 | 对齐 adapter 实际使用的 @types/pg 精确版本，更新 lockfile 与版本说明，不使用类型强转掩盖 | strict TypeScript 检查通过 |

实现文件：`scratch/boot01/test-environment.ts`、`run-isolated.py`、`infra-test-env.sh`、`prisma-pg-check.ts`、`bullmq-redis-check.ts`、`test-environment.test.ts`、`runner-lifecycle.test.py`；依赖、doctor 和契约复核见下方补充。

## 已验证与命令

在 `scratch/boot01` 执行：

```bash
node --import tsx --test test-environment.test.ts
python3 runner-lifecycle.test.py
bash infra-test-env.sh run
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2024 --module NodeNext --moduleResolution NodeNext test-environment.ts test-environment.test.ts prisma-pg-check.ts bullmq-redis-check.ts
```

- guard：10/10，通过，无网络连接。
- runner lifecycle：3/3，通过，覆盖端口占用不接管、测试失败清理、错误实例身份在 DDL 前拒绝。
- 真实 PG18：Prisma 事务提交、P2002 唯一约束、异常回滚通过。
- 真实 Redis8/BullMQ：任务完成并自然退出 0；runner 已停止其创建的服务并删除临时目录。
- strict TS：exit 0。`skipLibCheck` 仅跳过依赖声明文件内部检查，没有关闭源码的 strict 校验。

证据：本目录 guard.log、lifecycle.log、isolated-final.log、typecheck.log。测试只使用新建 test_ 数据，不触碰旧 Web、生产 SQLite、真实账号或外部 AI。

## 使用方式变化

现在使用 `bash scratch/boot01/infra-test-env.sh run` 完成完整隔离运行；`start`/`stop` 明确拒绝。不要手动构造 BOOT01_ENV_FILE 指向非 runner 实例。正式服务端及 BOOT-02 的环境实现仍是后续任务，不能复制这个实验 runner 作为生产部署器。

R2 报告描述历史问题；本轮新增报告和验证证据为当前状态。没有提交或推送代码。

## 契约、工具链补充复核

- Fastify 非法 timeline payload 现在返回符合 ApiErrorEnvelope 的 400；注入测试断言 code、details 与 requestId，Swift 增加真实 400 envelope 的生成类型解码测试。5 项 Swift 测试全部通过，服务端导出与 Swift 输入 JSON 完全一致。
- manifest、lockfile、TOOLCHAIN 已统一；@types/pg 为 8.23.1，消除 PrismaPg 外部 pool 的编译不兼容。doctor 检查 Node24、Swift6+、Xcode、PG18、Redis8；Docker 缺失会明确报告本地 profile 限制，REQUIRE_DOCKER=1 可强制失败。
- 在新的临时源码副本中排除 node_modules/.build 后，执行 npm ci、Prisma generate、guard、Fastify injection、完整隔离 runner，全部 exit 0。证据 clean-bootstrap.log。doctor.log、swift.log 为主审独立执行的结果。
- 独立子审复核父代理隔离修复后提出 createdb 应走私有 Unix socket；主审核对最终代码已经使用 `-h str(root)`，真实 SCRAM 认证运行和故障清理测试亦通过，因此该意见在最终代码中已满足，不列为剩余缺陷。

未验证部分明确保留：OCI 镜像拉取/容器运行、正式 CI、生产数据库迁移、上线性能、外部 AI provider。本轮没有因此把后续任务算作缺陷，也没有把本地成功写成生产接受。所有新文件仍未提交；先阅读本报告再继续后续任务，R2 的缺陷描述属于历史状态。
