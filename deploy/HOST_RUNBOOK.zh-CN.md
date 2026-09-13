# 161.33.201.230 上的独立部署步骤

本手册是待执行步骤，不能作为部署成功证据。直接 IP 的 SSH 在当前代理路径下超时；已核对 DNS 后通过 `ssh -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun` 登录同一主机。执行时从第 1 步核对现状。用户已授权部署，不需要再要求一次发布确认。

## 1. 先确认现有服务

- 使用用户确认的 SSH 端口连接 `ubuntu@161.33.201.230`；不要因为 22 超时而修改现有 sshd 或网络配置。
- 读取主机架构、CPU/空闲内存/磁盘、`ss -ltn`、`docker ps`（仅 names/image/ports）、`docker compose ls`、运行中的 systemd unit。不要输出其他服务的 environment。
- 确认没有现有 GrowDesk 项目、同名 Docker 网络/卷或发布目录；遇到重名先核对归属，不接管已有资源。
- 默认 API 回环端口为 3180，必须确认空闲。对外 HTTPS 使用另一个空闲端口，由现有 singbox nginx 转发；不要占用或重定向现有站点的 80/443。公开证书当前显示 `ampere.zwang.fun`，但仍须核对 nginx 真实配置、证书路径和域名归属。
- 记录 singbox nginx 的真实 binary、master 启动参数（尤其 `-c`/`-p`）、配置 include 路径、监听端口，以及现有站点可观察的 HTTP 状态。nginx 可能由 systemd 或容器管理，未核对前不能假定 `systemctl reload nginx` 就是目标实例。
- 检查部署资源预算：默认上限为 API 768 MiB/1 CPU、PG 2 GiB/2 CPU、Redis 512 MiB/0.5 CPU。为系统和原有服务留出余量；内存不足则先下调新栈预算，不能停原有服务腾空间。

## 2. 打包已提交版本

本机 `growdesk-server`：

```sh
npm run backend:typecheck
npm run backend:lint
npm run backend:test:unit
npm run backend:test:integration
# 提交本次完成的源码和证据，然后从干净工作区执行：
npm run backend:release:package
```

产物位于 `build/releases/growdesk-<完整Git SHA>.tar.gz` 和对应 `.manifest.json`。打包只使用 Git 已提交源码白名单，排除本机 `.env`、node_modules 和旧 Web。上传到目标机器新建的 `/home/ubuntu/growdesk/releases/<SHA>/`，并用 SHA-256 核对上传内容；不覆盖旧发布目录。

## 3. 只为新服务生成配置

在目标机 `/home/ubuntu/growdesk/shared/` 创建权限 700 的目录，并创建权限 600 的环境文件。只在文件不存在时生成，不覆盖已有凭据。密码用 Python `secrets.token_hex(32)` 等密码学随机源生成，不能用本仓库测试值。需要的键见 `README.md`：

- `POSTGRES_SUPERUSER_PASSWORD`：仅 PG 引导使用；API 不持有。
- `GROWDESK_DB_PASSWORD`：独立应用角色，仅 CONNECT/USAGE；未来业务迁移另设 migration role。
- `REDIS_PASSWORD`：独立 Redis 实例。
- `GROWDESK_IMAGE_TAG`：本次完整 Git SHA。
- `GROWDESK_HOST_PORT`：检查确认的回环端口。

不要把环境文件或含有真实密码的 `docker compose config` 输出复制到 Git/聊天/报告。用 `config --quiet` 校验；证据使用本仓库的 `compose.synthetic.json` 或脱敏配置。

## 4. 启动独立栈

在已上传发布目录运行（`shared` 指目标机配置目录）：

```sh
docker compose --env-file /home/ubuntu/growdesk/shared/runtime.env -f deploy/compose.yaml config --quiet
docker compose --env-file /home/ubuntu/growdesk/shared/runtime.env -f deploy/compose.yaml build api
docker compose --env-file /home/ubuntu/growdesk/shared/runtime.env -f deploy/compose.yaml up -d --wait --wait-timeout 180
docker compose --env-file /home/ubuntu/growdesk/shared/runtime.env -f deploy/compose.yaml ps
curl --fail --max-time 10 http://127.0.0.1:3180/health/live
curl --fail --max-time 10 http://127.0.0.1:3180/health/ready
```

端口改变时同步修改 curl 和 nginx upstream。必须看到 `stage: foundation`、PG/Redis 均 `ok`；这只证明基础运行依赖，不证明账号、业务 schema、协作、MCP 或同步已完成。此阶段不启动空转 worker/scheduler，不导入任何真实家庭资料。

只记录新项目的容器 ID、镜像 digest、OCI revision、健康状态、内存/CPU 和端口。若失败，只停止或修复本次 GrowDesk 栈；禁止 `docker system prune`、全局服务重启、`down -v`、覆盖旧数据库。

## 5. 接入既有 singbox nginx

- 从 `nginx/growdesk.conf.template` 生成一个新的独立 include，替换全部占位符。证书必须覆盖实际访问域名；不要把 HTTP 或自签名证书当成 iOS HTTPS 联调完成。
- 模板仅适用于 nginx 位于主机回环网络的情况。若 nginx 在 bridge 容器中，先确认其网络方案；不要把 `127.0.0.1` 错当宿主机，也不要将 PG/Redis 发布公网。仅将 nginx 接到新建的 API 入口网络，或使用其已有受控宿主机路由。
- 新 include 安装前备份相关配置与 hash；不要替换主配置、已有站点或 singbox 进程。
- 使用已查明的同一 nginx binary/config/prefix 做 `-t`。失败时移除本次新增 include；不 reload。
- 校验成功后对同一 nginx master 做 graceful reload（不是 restart），再确认新 worker 正常运行。
- 从外部使用正确域名和新 HTTPS 端口验证 `/health/live`、`/health/ready`；检查未开放业务路径返回 404。再次检查所有预检中记录的旧站点、容器和监听端口。
- 只有这些结果实际通过，才能在 CLOUD_BOOTSTRAP 报告写“已部署”。本轮模板限制只公开健康接口，后续业务 API 必须经过鉴权/隔离验收再增加反代路由。

## 6. 回滚边界

如果新 nginx include 导致检查失败，恢复/移除该 include、用同一实例 `-t` 后 reload；保留其他配置不变。若仅 GrowDesk API 失败，可以停止新 API 或切回上一个已记录镜像。PG/Redis named volumes 必须保留，不能通过删除卷“修复”问题。当前没有业务 schema migration，后续数据库变更采用 forward fix，不将生产库降级。


## 7. 当前主机的实际运行参数（2026-09-12）

SSH：`ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun`。域名已核对指向目标IP；直连IP在当前本地代理路径曾卡在SSH banner前。

Compose v5.5.1 位于 `/home/ubuntu/growdesk/bin/docker-compose`，Buildx v0.37.1 位于独立 Docker 配置目录；未升级系统 Docker 或重启旧容器。此主机需 sudo：

```sh
sudo env DOCKER_CONFIG=/home/ubuntu/growdesk/docker-config \
  /home/ubuntu/growdesk/bin/docker-compose \
  --env-file /home/ubuntu/growdesk/shared/runtime.env \
  -f /home/ubuntu/growdesk/releases/eab46cba648611f22bd5a0c7721a5e102b39597e/deploy/compose.yaml ps
curl --noproxy '*' --fail https://ampere.zwang.fun:8443/health/ready
```

后续发布创建新的不可变 release 目录，核验源码包哈希，再只更新 `runtime.env` 的 `GROWDESK_IMAGE_TAG`；保留密码和600权限。`bootstrap-target.py` 仅用于首次引导，不替代升级发布步骤。

nginx原PID文件为空，不能依赖 `nginx -s reload`。`activate-nginx.py` 使用精确 master 命令及 `/proc/PID/exe` 双重确认后发 SIGHUP；脚本只用于首次接入，已有include时主动拒绝重复覆盖。调整路由时必须重新 `nginx -t -c /etc/sing-box/nginx.conf`，再对核实的 master 发HUP。

撤销本次公网入口：移除且仅移除 `/etc/sing-box/nginx.d/growdesk.conf`，检查配置后平滑重载上述master；`systemctl disable --now growdesk-firewall.service`，移除本次unit后daemon-reload；用以下精确规则删除本次放行：

```sh
sudo iptables -D INPUT -p tcp --dport 8443 -m comment --comment 'GrowDesk HTTPS' -j ACCEPT
```

需要停止API时，使用上面的完整Compose命令追加 `stop api`。保留PG/Redis卷和运行配置，禁止 `down -v`。不修改已有80/443站点、旧PG16/Redis、BabyPanel或全局Docker网络。
