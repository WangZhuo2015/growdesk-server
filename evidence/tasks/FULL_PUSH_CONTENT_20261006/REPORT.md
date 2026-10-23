# 完整照护推送已部署

用户要求把“有新的照护记录”改为完整内容，并沿用原推送密钥与浏览器订阅。已于 2026-10-06 部署到现有 API、Web 和通知 worker；本报告记录限定实现、独立审查、隔离验收及实际发布回执，不标记整个新服务为 ACCEPTED。

## 最终行为

- 喂奶、睡眠、尿布、辅食、补剂、生长测量会显示记录人、宝宝、操作及记录类型，并提供当次的时间、数量/时长、类型、产品或食物、测量值及备注等有值字段。
- 在原记录写入事务内生成版本化的 title/body 快照；通知 inbox 与实际 WebPush/APNs 使用该内容。后续改动不会把旧事件替换成新记录详情；备注保留内部换行和空格。
- 旧待发送任务缺少快照时，只在记录版本仍匹配时补详情；版本变化或原记录缺失时明确显示旧版本说明。已经产生且不可恢复原版本的通用历史通知不能凭空补回原详情。
- WebPush 的 UTF-8 JSON 限制为 3072 字节，超长正文只在发送载荷截短并添加“点击查看完整内容”；inbox 保存全文。通知页标题换行、正文取消两行限制。原事件去重键、topic/tag、权限、静默和 fence 路径保持。
- 沿用原 VAPID 配置与订阅，没有重置/批量注销订阅、修改生产配置文件或数据库迁移。仅通知 worker 继续使用 `--notifications-only`。

## 源码及验证

服务端产品源码 `8b9edd3be223c2e784bf3ba617d7f11eac27323a`，从干净 Git archive 交叉构建 Linux arm64 API/worker，保留已部署 65cc 的 ASR/Passport 基线。Web 源码 `c366c6818887fb400d541dc679fc5c5b936392b0`，相对 5c8156d 仅两处展示 CSS。测试脚本单独提交 `6c2ca252dddc2bd6791c7f428d1ee225241c346e`，SHA-256 `60851779f7ec5e8eb1a1a9868b0a9d2e8c9134a353cbd997b1e622e2cfd58f39`。

完整 `go test ./...`、Web TypeScript/oxlint/diff 检查及最终 Next 16.3.6 standalone 构建通过。独立产品源码审查和限定发布审查没有剩余可复现阻断。

真实隔离 PostgreSQL 18/Redis 8、非超级用户 test_ 租户、Go API/worker 和加密 WebPush loopback 验收 **26/26 通过**：290 项 HTTP 断言、124 次实际 worker、53 次加密并解密的 WebPush 请求。覆盖六类记录各 create/update/delete/restore、事件快照抗后续修改、旧任务版本回退、跨家庭隔离、权限撤销、静默、重试/终止、65-device、metadata/profile、3072 字节长 Unicode 正文及 inbox 全文；AI 空附件重放明确预期 202。旧系统配额专门验收未在这个 runner 重跑；本次没有修改配额路径。

基线 65cc 的实际加密载荷解密后仅通用标题正文，详细内容判据明确 RED。最终源码输入摘要前后相同：`b2e611dfdc23851892c34774071019903364788f613655f280501758585a3241`，drift=[]；临时 PostgreSQL、Redis、API、worker 和 fixture 全部清理，错误=[]。中间两次 fixture/runner 断言失败也保留在证据中，没有把它们算为通过。

## 部署与保留

API SHA-256 `684afa52949eb01b7df88ab3883a1bf84981a14e5b29fac00835c1aae97349e4`；worker SHA-256 `6c143450b3fa39708dbef99996931ac29a1ccc05df3ba3c6ac9d8e4e59bdf4fd`；Web artifact SHA-256 `ca5ad7f43ea8f77799defe432e6d368608e65a78d6d229f10ae608c55fed94b5`。实际运行进程哈希和版本已核对；API/Web/通知 worker 均 active/running、NRestarts=0。PostgreSQL/Redis readiness 正常，公开通知页、SW 和 Passport 页面为 200，未认证受保护路由为 401。

新发布目录 `/home/ubuntu/growdesk/push-releases/full-record-content-20261006`；备份目录 `/home/ubuntu/growdesk/push-releases/full-record-content-20261006/rollback`。先停止旧通知 worker，再切换 API/Web 并启动同一通知工作范围。失败回滚会校验恢复到原 API 3068、worker 499 以及旧 Web provenance；本次未触发回滚。

服务器源页与上次构建源不完全相同，因此只应用两处精确 CSS 替换，其他源内容保留；原 `.env` 与 `api.env` 的大小、mtime、权限和属主前后相同。运行时 archive/uploads/backups/LLM profile 文件保留。本次没有读取或输出生产 secret 值、使用生产账号写测试记录、直接连接生产库运行验收或发真实测试推送；部署后的 health/status GET 是只读操作。

本地原工作区 HEAD 没有改变，只整合本次拥有的 6 个服务端/runner 路径与通知页两处 CSS；其余 67 个服务端、20 个 Web 已存在的 tracked/untracked 修改哈希不变。没有覆盖用户未提交工作或推送 Git 远端。

实际设备上的系统通知展示未单独验证；上面的推送验证使用真实加密发送和 owned loopback 接收器，不等同于真实厂商网关或物理设备到达。

## 证据

- `server-source.diff` / `web-source.diff` / `runner-source.diff`
- `CONTENT_REPORT.md` / `REVIEW.md` / `RELEASE_REVIEW.md` / `go-all.log`
- `backend-921d1832a1c0/persistence-report.json`：基线 RED
- `backend-92bd22c76b9b/persistence-report.json` 与 `backend-cleanup.json`：最终 GREEN 和清理
- `runtime-summary.json` / `integration-preservation.json`
- `remote/deployment-receipt.json` / `remote/web-build-verification.json` / `remote/service-final.json` / `public-verification.json`
- `operations/activate.py` / `bundle-manifest.json` / `final-operation-update.json`：经过审查的最终发布脚本与运输后 metadata overlay
