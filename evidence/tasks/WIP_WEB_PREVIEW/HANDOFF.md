# WIP — GrowDesk / 旧 Web 隔离接入交接

给接手ChatGPT的完整入口：[CHATGPT_HANDOFF.md](../../../CHATGPT_HANDOFF.md)。

日期：2026-09-14。状态：**WIP / IMPLEMENTED_NOT_REVIEWED / NOT_DEPLOYED**。
用户要求先保存、提交并 push 当前进度，由其他 agent 继续。不要把现有报告里的 ACCEPTED 当作本批已验收。

## 配套分支和工作目录

两个 GitHub 仓库均使用分支 `codex/wip-growdesk-web-integration-20260914`，必须配套检出：

- Web: https://github.com/WangZhuo2015/baby_panel_for_cecilia/tree/codex/wip-growdesk-web-integration-20260914
- API: https://github.com/WangZhuo2015/growdesk-server/tree/codex/wip-growdesk-web-integration-20260914
- Web 副本：`/home/ubuntu/Github/baby-panel-growdesk-review`
- 后端副本：`/home/ubuntu/Github/growdesk-server-preview`

Web 基线 `4511348`，本次还合并原运行目录已提交的 `143f4a9`（本地独有 11 个提交）。合并保留多奶粉、睡眠计时、持久 AI 会话、细粒度 MCP、使用统计、平板布局与日报代码。MCP 文本冲突通过保留本地完整实现解决；**新模式 MCP 接入仍未完成，不能直接放行**。Web WIP 提交有两个父提交，保留原提交历史。
后端基线 `208e104`。

## 用户目标和必须保留的边界

补齐旧 Web 使用 GrowDesk 新后端的功能，在独立端口暴露试用版；用户试用后自己决定正式切换。
原 `/home/ubuntu/Github/baby_panel_for_cecilia`（3088）与原 `growdesk-server` 容器（3180）保持运行，禁止在它们的目录 build/deploy、改 .env/.next、重启或改写数据库。原 Web 未提交的 cron/backup 工作没有被带进这次副本，也没有改动。
2026-09-14 提交前实测：baby-panel active，MainPID=892386；3088 首页 200；3180 `/health/ready` 200。
本轮没有改 nginx，没有公开预览端口，没有导入真实家庭/宝宝/历史数据。

## 已完成的独立基础设施（仅此主机，不是生产）

- Docker project `growdesk-preview`；容器 `growdesk-preview_postgres_1`、`growdesk-preview_redis_1`、`growdesk-preview_storage_1`。
- PostgreSQL 18：127.0.0.1:55432，database `test_growdesk_preview`，role `test_preview`。
- Redis 8：127.0.0.1:56379；私有 MinIO S3：127.0.0.1:59000，bucket `growdesk-preview`。
- 后端拟用回环端口 3181；前端尚未选定/公开，不要占用原端口。
- 仅本机的配置目录 `/home/ubuntu/Github/growdesk-integration-assessment/runtime/`，权限700。`backend.env`、`compose.env`、`init.sql` 含本次随机生成的预览凭据，不在 Git 中。
- Compose 文件与数据卷已存在，同机继续无需重建；保留当前预览数据。异机需要自行创建隔离凭据/角色/卷，不能把本机 secret 文件加入 Git。
- 独立 Node 24.14.1：`/home/ubuntu/Github/growdesk-integration-assessment/toolchain/node_modules/node/bin/node`；系统 Node 为22。
- 两个副本已有独立 npm ci 依赖；Web `.env.test` 来自公开 `.env.test.example`。不共享原服务 node_modules/.next。
- 新 migration `202609140013_medical_items`、`202609140014_book_status` 已在本次预览库应用，未在生产应用。

## 当前验证，不要升级为全站验收

- 本次真实预览 PG/S3 医疗测试已通过：检查项保存/更新、私有对象上传读取、跨家庭拒绝、医疗附带生长测量、旧版本删除409和时间线删除。
- 本次真实预览 PG 绘本测试已通过：收藏/阅读次数持久化、跨家庭写入403、陈旧版本409、家庭变更流。
- 提交前新增知识/AI provider本地fixture测试：7/7通过。它不是外部AI、完整worker或浏览器验收。
- 提交前 Web新增记录测试：3/5通过，2项日期边界断言失败。
- 提交前 Web typecheck：失败；后端 build：失败。具体日志在各仓库本目录。
- 未通过完整浏览器 + Web + API + PG 联合 E2E；未公开可试用站点；未做完整静态检查/全套测试/正式迁移演练。
- Git diff --check 通过。

## 接手顺序

1. 先修本目录日志中的编译错误和记录日期测试，不要通过跳过测试/放宽权限来绕过。
2. 对照 `lib/growdesk/bridge-policy.ts` 逐method检查：注册/家庭/invite和日报已有部分实现，但尚未统一加入允许清单；放行前验证真实调用，禁止fallback SQLite。
3. 完成账号/多家庭/多宝宝 UI 和 onboarding，头像上传显式传 familyId/babyId，校验缓存清理。当前 saveBaby 类型在slice/store之间不一致。
4. 继续营养：奶粉完整字段、默认/多奶粉、补剂产品/计划/打卡、营养分析。目前后端补剂产品/计划模型缺失，已有适配会丢字段。
5. 继续疫苗完整资料/选择/剂次、food/library/plans、growth与通知等剩余兼容性。不要只取消501就声称完成。
6. 完成Web AI会话/SSE重连/取消与新worker联通。当前新增provider、worker/scheduler和持久事件代码尚需真实隔离队列验收；voice/daily summary processor明确未实现。confirm只支持有限feeding create计划，不代表全工具执行。
7. MCP/OAuth/PAT/使用统计尚缺新后端正式实现；当前Web仍保留旧实现，保持阻断直连SQLite。
8. 外部AI/语音/搜索配置尚未授权读取旧生产密钥；此前已异步询问用户但未收到明确选项。可继续fixture测试，不能把fixture模式作为真实AI向用户交付。
9. 完成配置/契约注册及生成：新增知识/附件/绘本/天气路径与schema尚需全面校对 `packages/contracts/src/routes.ts`，重新生成OpenAPI/SDK并检查diff。旧快照不是本批完成证据。
10. 全部通过后构建独立前后端、配置单独HTTPS入口（生产BFF cookie要求Secure），给用户试用。生产数据迁移/最终写权威切换留到之后，不冻结或停止现有服务。

## 继续验证的命令

```bash
# Web副本
npm run typecheck
node --env-file=.env.test --import tsx --test tests/unit/growdesk-records-preview.test.ts

# API副本；PATH先加入本机独立Node24的bin
npm run backend:db:generate
npm run backend:build
node --import tsx --test apps/api/tests/knowledge-preview.test.ts apps/api/tests/ai-provider-config.test.ts apps/worker/tests/ai-provider.test.ts
# 仅同机本次预览环境，测试会创建/清理自己的test_租户
node --env-file=/home/ubuntu/Github/growdesk-integration-assessment/runtime/backend.env --import tsx --test scripts/preview/medical-storage.test.ts scripts/preview/books.test.ts
```

旧`npm run test:api:server`只能在旧Web规范规定的隔离测试环境运行，不能连接原3088/生产SQLite。新后端原 integration runner要求本机PG18/Redis8独占进程，此主机只有PG16/Redis7可执行文件，本次用单独容器做新增真实PG/S3测试；不要直接假设原runner可用。

## API 本批实现与明确缺口

- 知识参考数据来自旧Web已托管JSON，保留release/source metadata；新增知识、绘本、天气接口。
- 正式医疗items JSONB和家庭绘本状态模型，迁移013/014；补医疗附带测量、版本化删除/投影、附件归属检查。
- 启动要求JWT_SECRET与S3_BUCKET，S3校验实际hash；附件下载鉴权和头像引用绑定；本批仍需独立安全review。
- AI子代理新增provider、chat processor、SSE事件与worker/scheduler运行代码及部分测试，停工时未交付最终运行证据。
- 最后build被`apps/api/src/services/weather-service.ts`阻断：response.json()为unknown，须添加正确运行时校验/类型收窄，不要用any遮盖。见build.log。
- OpenAPI生成产物尚未同步本批修改；附件/医疗/书籍的完整版本、change feed、幂等与权限并发行为仍需系统review。
- 不应把MockStorageDriver的测试存在当成真实存储能力；本次server入口要求真实S3配置，但buildApiApp测试注入仍保留Mock。
