# BOOT-02 阶段实现报告

日期：2026-09-11。基线 `182a3be569a9a5704a9998cae3c8a35429d9d549`，起始分支 `main`，交付工作分支 `codex/backend-storage-foundation`。本轮改动未提交、未推送、未部署。实现状态：`IMPLEMENTED_NOT_REVIEWED`；独立复核与保留项见 `REVIEW.md`，不代表完整后端验收。

## 已落地

- 正式 npm 工作区、精确依赖 lockfile、API / worker / scheduler 独立构建，严格类型检查覆盖集成测试。
- Fastify `/health/live` 的真实进程检查。worker / scheduler 为明确标注的 idle 生命周期骨架，校验配置、保持运行并响应 SIGTERM；尚无业务处理器。
- PG / Redis 前置配置筛查、testkit 精确连接身份 guard，以及拥有专属进程和临时目录的隔离集成 runner。没有使用旧 Web SQLite。
- 领域层云同步授权：未开启默认拒绝；校验绑定 ID、用户、设备、本地资料库、家庭、代际、授权版本与当前成员权限。viewer 可拉取但不可上传。它是纯策略，尚未接入数据库事务或端点。
- AST 依赖边界检查、独立静态 / 集成 CI job 配置。未实现的业务契约和迁移命令返回非零；删除了不属于育儿产品的桌面硬件契约，以及未经冻结的业务 schema。
- 计划 07 与旧计划入口已对齐最新产品决定：应用联网，业务数据可仅本机保存；在线 AI 的本次发送授权与全库同步独立。协作和云端 MCP 需要联网及相应云数据授权。

## 本地验证

| 验证 | 结果 | 证据 |
|---|---|---|
| 干净源码副本安装、类型检查、构建 | 通过；未复制 `.env` / 现有 node_modules / scratch | `clean-install.txt` |
| 全工作区 typecheck / build / lint | 通过 | `typecheck.txt`、`build.txt`、`lint.txt` |
| 单元与进程生命周期测试 | 47/47 通过 | `unit.txt` |
| testkit / 数据库 guard | 18/18 通过，已包含于上述总测试 | `guard.txt` |
| 父侧同步授权与精确连接 guard | 24/24 通过，已包含于上述总测试 | `sync-and-guard.txt` |
| 独立 PG18 / Redis8 | 2/2，通过真实 rollback / unique / NX / TTL | `integration.txt` |
| 隔离 runner 故障注入 | 3/3，通过占端口、失败清理、错误 PG 标识先于 DDL 拒绝 | `runner-lifecycle.txt` |

生命周期报告中的 Node 测试失败是故意修改实例标识后的预期结果；外围 Python 测试 `OK`，并通过 SQL 确认未创建业务测试表。日志没有临时凭据。

## 保留项与下一步

1. BOOT-02 尚无 S3 模拟服务与对象存储测试；`backend:deps:test` 当前运行并清理 PG / Redis 自检，不创建常驻环境。补齐对象存储测试后才能说测试依赖全部就绪。
2. CI 配置已写入，尚无 GitHub Actions 实跑记录；Homebrew 安装只由 runner 核对 PG18 / Redis8 主版本，不宣称服务端二进制已按 patch/digest 完全可复现。
3. evidence checker 只检查报告形状和常见敏感串，不等于独立 review，也不是完整泄密扫描。
4. BE-01：建立逐字段映射、完整 endpoint inventory、绑定 / 首次导入契约、OpenAPI 与 TS / Swift fixture 流水线。当前 contracts 仅正式公开 health schema。
5. BE-02–05：建立 PostgreSQL 业务模型、会话、家庭与持久同步绑定，在同一事务验证权限 / generation 和执行写入；用真实并发测试证明暂停、撤销和重复提交行为。
6. iOS 同期只落地策略与入口说明，本地正式库、云同步和跨端联调另有任务。当前结果不能用于声明重启不丢数据、真实家庭协作或 MCP 已可用。
7. 尚无生产迁移、负载测试、真实性能容量或部署证据；没有触碰真实家庭数据。

复现命令与安全边界见 `docs/BACKEND_DEVELOPMENT.md`。后续 Agent 应从本报告保留项继续，不重建工作区，也不要将只有规划的业务能力标记完成。
