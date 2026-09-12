# GrowDesk 云端基础运行栈

状态：FOUNDATION_DEPLOYED。日期：2026-09-12（US/Pacific）。本阶段先让独立基础服务可运行，业务账号、记录同步、协作与 MCP 尚未完成。

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

已部署至 `ubuntu@161.33.201.230`（经 DNS A 记录确认的 `ampere.zwang.fun`）。公网健康入口：

- https://ampere.zwang.fun:8443/health/live
- https://ampere.zwang.fun:8443/health/ready

运行源码版本：`eab46cba648611f22bd5a0c7721a5e102b39597e`，源码包 SHA256：`27ee4b683254b7bdb5f84896555aaf2792d4c331ec68d6f1f9916e4f1bc3a293`。主机原生 ARM 构建成功；API/PG18.6/Redis8.10.1 均 healthy。`runtime.json` 记录实际镜像 ID、网络和端口，应用 PG 角色的超级用户/建库/建角色/复制/bypassRLS 标志均为 false。

API 只绑定宿主回环 `127.0.0.1:3180`，PG/Redis 不发布端口。独立入口 bridge 修复 Docker 29 中“容器健康但仅 internal 网络不发布宿主端口”的问题；PG/Redis 仍各自在内部网络。

复用 `/usr/sbin/nginx -c /etc/sing-box/nginx.conf`，只新增 `/etc/sing-box/nginx.d/growdesk.conf`，使用已有域名证书和新端口8443；只开放健康路径，业务路径404。添加 GrowDesk 专属 iptables TCP8443规则与 `growdesk-firewall.service`，不覆盖已有防火墙。原 nginx PID 文件为空导致第一次 `-s reload` 失败，撤回新增配置并清理本次 unit/rule 后，改为唯一识别真实 master 并校验 `/proc/PID/exe`，发送 SIGHUP 平滑重载。主进程892230未重启。

公网三项检查通过并校验证书：live200、ready200（PG/Redis均ok）、未开放业务路径404，见 `external-https.json`。本机默认代理访问8443曾超时，使用 `curl --noproxy '*'` 后通过；没有关闭TLS验证。

现有41个运行服务的PID/启动时间、3个容器ID/启动时间、4份既有nginx配置hash、3个旧站点状态前后完全一致。跨实际重载时刻的135次站点采样均符合基线（ampere401、ampere-cf200、baby200），见 `preservation-check.json`、`successful-reload-site-monitor.json`。这是本轮观察结果，不代表完整业务端到端或长期可用性保证。

`nginx-reload-monitor.json` 是第一次部署前采样；`activation-site-monitor.json` 覆盖失败尝试；只有 `successful-reload-site-monitor.json` 用作成功重载观察证据。

## 保留项

当前不提供业务API、业务schema迁移、认证、云同步、对象存储、在线AI/OCR或MCP；不能接受真实家庭数据。基础健康检查不能证明业务容量、备份恢复、客户端联调或完整生产可用性。数据库默认创建最小权限应用角色；业务迁移需另设受控migration身份，不让API持有PG超级用户凭据。
