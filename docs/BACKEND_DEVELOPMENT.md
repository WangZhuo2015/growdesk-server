# 后端开发与隔离验证

工作目录为 `growdesk-server`。先读 `START_HERE.md` 和当前任务报告；本文件描述已经落地的基础命令，不代表业务后端已完成。

## 安装与静态检查

使用已锁定的 Node 24 和根 `package-lock.json`：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run backend:typecheck
npm run backend:build
npm run backend:lint
npm run backend:test:guard
npm run backend:test:unit
```

API、worker、scheduler 分开构建。API 的 `/health/live` 只证明进程存活，不代表数据库、认证或业务就绪。尚未实现的契约生成和数据库迁移命令必须非零退出，不能用于发布验收。

## 真实基础设施测试

需要 PostgreSQL 18 和 Redis 8 的本地可执行文件。runner 从 PATH 查找，也支持通过 `PG_BIN`、`REDIS_BIN` 指定二进制目录；macOS 有 Homebrew 路径回退。不要传入业务数据库地址，不读取 `.env`。

```sh
npm run backend:test:integration -- --suite infrastructure
python3 tests/integration/runner-lifecycle.test.py
```

每次运行创建独立的私有临时目录、随机 loopback 端口、临时凭据和非超级用户 `test_runner`。连接后先核对 PostgreSQL 实例标识、数据库及角色，再执行 DDL。退出时只终止本轮持有的子进程，清理整个临时目录，不接管已存在的服务。

第一条命令验证真实 PG 唯一约束、事务回滚和 Redis 原子 NX/TTL。第二条验证端口占用不接管、测试失败仍清理、错误实例标识在 DDL 前拒绝；其中错误实例子测试出现预期失败输出，Python 总测试结果应为 `OK`。未知 suite 在资源创建前报错，不能静默执行其它测试。

纯配置 parser 的 loopback / `test_` 名称检查只是一层前置校验。它不能替代 runner 的实例所有权验证，也不能让实现 Agent 自行连接“名字像测试库”的现有服务。

## 当前业务边界

云同步授权函数只实现纯策略，没有持久绑定、HTTP 同步端点或真实并发事务。BE-02 之后必须把绑定状态、代际和最新家庭成员权限的检查放入同一个业务事务；不能先查询权限、释放事务后再写入。

本机保存限制数据上传，不关闭普通网络，也不替代账号流程。在线 AI 的本次内容发送与全库同步分开授权。详细协议与用户提示见 [计划 07](plan/implementation/07_LOCAL_FIRST_OPTIONAL_SYNC.md)。

测试证据放入 `evidence/tasks/<TASK-ID>/`，使用可跟踪的 `.txt` 输出和 Markdown 报告。报告分别记录本地检查、云端 CI、真实设备与部署状态；本地通过不能代替其余证明。
