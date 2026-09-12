# 161.33.201.230 连接检查

目标：`ubuntu@161.33.201.230`。日期：2026-09-11（US/Pacific）。

- `ssh -G`：用户 ubuntu、22 端口、没有 ProxyJump / ProxyCommand。
- `ssh -o BatchMode=yes -o ConnectTimeout=10 ...`：在 banner exchange 阶段超时。
- `ssh -o BatchMode=yes -o ConnectionAttempts=2 -o ConnectTimeout=20 ...`：同样在 banner exchange 阶段超时，尚未到公钥认证阶段。
- 独立 TCP 检查：22 可以建立 TCP，但 5 秒内没有 SSH banner。
- HTTP 80：301 跳转 HTTPS，公开响应头 `Server: nginx/1.24.0 (Ubuntu)`。
- HTTPS 443：能够 TLS 握手；服务端公开证书 CN / SAN 为 `ampere.zwang.fun`，因此直接用 IP 做 HTTPS 主机名验证会失败。只检查公开证书，没有读取远端证书私钥。
- 当前电脑对该域名返回 `198.18.0.77`，属于代理使用的 fake-IP 地址；未擅自修改电脑网络或代理设置。

上述结果不能证明 nginx 的运行方式、singbox 配置路径、SSH 实际监听端口或服务器可用资源。尚未 SSH 登录、上传文件、启动容器、更改端口或修改 nginx。需要确认 SSH 端口/跳板或恢复当前连接后继续远端预检。

## 连接恢复

通过 Cloudflare DNS-over-HTTPS 核对 ampere.zwang.fun 的 A 记录为 161.33.201.230 后，使用域名建立 SSH，并设置 HostKeyAlias=161.33.201.230 保留同一主机密钥验证，成功免密登录。未更改本机代理或远端 sshd。之前超时属于当前 IP 连接路径问题，不是免密配置失效。

目标主机 aarch64，Docker Engine 29.1.3，尚无 Compose/buildx CLI；24 GiB 内存、可用约13 GiB，根磁盘剩余41 GiB。现有 PostgreSQL16/Redis/旧 Baby Panel 和其他服务保持运行。真正主 nginx 为 /usr/sbin/nginx -c /etc/sing-box/nginx.conf；不使用默认 /etc/nginx/nginx.conf，也不操作 webtop 容器内的另一份 nginx。
