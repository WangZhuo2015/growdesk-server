# GrowDesk 云端基础运行栈

状态：IMPLEMENTED_NOT_REVIEWED。日期：2026-09-12（US/Pacific）。本阶段先让独立基础服务可运行，业务账号、记录同步、协作与 MCP 尚未完成。

## 本地实现与验证

- 保留并完成提交既有 BOOT-02 工作区、宝宝多对多授权策略和隔离测试基础，没有重建工程或读取旧 Web 生产配置。
- API 新增 `/health/ready`，用真实 PostgreSQL `SELECT 1` / Redis `PING` 检查连接；失败返回503，live独立返回200。响应标明 `stage: foundation`，不暴露地址、凭据或驱动错误。
- 探针并发共用在途检查、超时有界、错误事件受控、退出关闭连接。默认缺配置不误报 ready。
- API 非root、多阶段 OCI 构建；PG18和Redis8使用独立内部网络与持久卷，数据库不发布宿主端口；API只发布回环3180。资源、日志轮转、restart、健康检查已配置。无处理器的 worker/scheduler 不启动。
- 镜像已通过官方 Docker Registry 验证并锁定 digest：Node24.14.1、PG18.6、Redis8.10.1。PG18卷路径 `/var/lib/postgresql` 遵循[官方镜像说明](https://hub.docker.com/_/postgres)。
- 复用 singbox 既有 nginx，新增独立TLS端口配置模板，保留既有路由；只有目标实例 `nginx -t` 成功后才做[graceful reload](https://nginx.org/en/docs/switches.html)。
- 干净Git源码打包脚本生成release tar.gz和SHA256 manifest，不打包环境文件、依赖目录或旧Web；中文执行/回滚手册位于 `deploy/HOST_RUNBOOK.zh-CN.md`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| typecheck / build / lint | 通过 | typecheck.txt / unit.txt（包含build）/ lint.txt |
| 单元与进程测试 | 74/74通过 | unit.txt |
| 真实隔离PG18.6/Redis8.10.1及HTTP readiness | 3/3通过；包括Redis认证失败503而live200；已清理进程与目录 | integration.txt |
| Compose5.5.1官方CLI schema/边界校验 | 通过；使用合成凭据，不启动本机Docker | compose-validation.txt / compose.synthetic.json |
| 目标机连接预检 | 已通过域名免密登录同一IP | REMOTE_PREFLIGHT.md |

## 部署状态

远端尚在部署准备阶段，不能把本地测试或SSH登录当成部署完成。上传版本、端口、nginx结果、现有服务前后检查和公网验证将在实际运行后另一个提交中补充。

## 保留项

当前不提供业务API、业务schema迁移、认证、云同步、对象存储、在线AI/OCR或MCP；不能接受真实家庭数据。基础健康检查不能证明业务容量、备份恢复、客户端联调或完整生产可用性。数据库默认创建最小权限应用角色；业务迁移需另设受控migration身份，不让API持有PG超级用户凭据。
