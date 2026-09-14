# 给 ChatGPT：GrowDesk / Baby Panel 接入任务交接

这是一项跨两个 TypeScript 仓库的继续开发任务。你可以独立判断设计、修正此前实现中的错误，并提交有边界的完整修复。下面记录的是可验证事实和未完成状态，不是要求你机械沿用当前代码。**当前是 WIP，不能直接部署。**

## 1. 用户真正要的结果

保留 Baby Panel for Cecilia 已有页面、交互和功能，把其业务数据访问接到 GrowDesk 新后端。不要重做一个简化前端，也不要为了演示成功删掉旧功能。

在独立副本、独立数据库/存储、独立端口完成开发。完整验证后公开一个新的前端试用地址，用户先试用，再自己决定切换。**现有旧前后端不能中断，当前没有生产切换授权。**

用户最新要求是先提交WIP交由你继续；你可以通过PR或patch包交付，再由宿主agent审核、测试、合并和部署试用。你不需要拥有这台主机才能完成代码工作。

## 2. 必须一起获取的两个仓库

| 仓库 | 分支 | 本次冻结的代码基线 |
|---|---|---|
| [baby_panel_for_cecilia](https://github.com/WangZhuo2015/baby_panel_for_cecilia/tree/codex/wip-growdesk-web-integration-20260914) | `codex/wip-growdesk-web-integration-20260914` | `35cdb7ea15f1c5a0e02c674a63d258d3d3d8bb98` |
| [growdesk-server](https://github.com/WangZhuo2015/growdesk-server/tree/codex/wip-growdesk-web-integration-20260914) | `codex/wip-growdesk-web-integration-20260914` | `ee355d809b6b153215d9fb215173fc7198885ccd` |

**分发状态（2026-09-14）：本机已提交上述WIP，但当前GitHub认证推送返回403，尚未确认远端分支存在。若分支链接不可访问，请使用随附源码ZIP或Git bundle；ZIP内MANIFEST.json记录实际快照HEAD，离线补丁以该SHA为base。具备写权限的宿主将bundle分支推送后，才可按下文向该WIP分支提PR。**

这两个code baseline之后可能仅有交接文档提交。若你能clone，以实际检出的WIP HEAD作为你的base SHA并在交付中报告；不要从main开始、不要误把main缺失的WIP功能又实现一遍。

Web的WIP基线是合并提交：父分支最新远端 `4511348` 与旧运行目录已提交的 `143f4a9`。后者包含尚未在当时远端出现的11个本地提交：持久AI会话、多奶粉、睡眠计时、细粒度MCP/使用统计、布局及日报等。保留这些功能，不能用旧远端文件覆盖掉。

如果你无法访问某仓库，先说明缺哪份源码。不要仅凭handoff虚构未见过的接口、数据库字段或测试结果。源码包若提供，目录名就是仓库名；MANIFEST记录精确快照SHA。

## 3. 架构和责任边界

```text
Browser -> Next.js 同源 /api 兼容层(BFF) -> GrowDesk Fastify /api/v1 -> PostgreSQL
                                              |-> 私有 S3 附件
                                              |-> 持久任务 / Worker / Scheduler / Redis
```

- Web继续使用Next.js 16与React；新后端为Node24/Fastify5/TypeBox/Prisma7/PostgreSQL/Redis。
- **只有GrowDesk拥有业务数据库访问权。** 新模式BFF不能持有PG连接，不能读写旧SQLite，不能在API失败时回退旧库或双写。
- BFF负责旧字段/新契约的明确转换；授权、事务、幂等、并发版本、持久任务由后端执行。不要在代理层另写一套会漂移的核心业务。
- 后端 `packages/contracts/src` 是权威契约，`contracts/openapi.json` 和生成客户端必须同步。不静默忽略旧字段，也不把真实失败包装成200。
- 区分FamilyMember与BabyMember。客户端/LLM传入的userId/familyId/babyId不是授权。多宝宝缓存、请求、附件和任务都要绑定所选宝宝。
- 更新/删除使用页面已观察到的版本；不要先重新读取最新版本再删除，这会绕过冲突保护。幂等键在重试中保持稳定。
- UI既要保留正常流程，也要能处理上游故障、会话过期、撤权、409冲突、上传失败和SSE重连。失败时不能误报保存成功。

## 4. 先读这些文件

两库AGENTS；Web若能安装依赖，读所用版本 `node_modules/next/dist/docs/` 的route handlers/cookies/proxy/streaming指南。
后端 `START_HERE.md`，以及 `docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md`、02契约、04功能、08账号宝宝关系的相关章节。

本次状态入口：两库都有 [evidence/tasks/WIP_WEB_PREVIEW/HANDOFF.md](evidence/tasks/WIP_WEB_PREVIEW/HANDOFF.md)。该目录的日志是**本次提交前**结果。

旧计划中的ACCEPTED/SH任务状态存在与源码不符的情况。以当前代码和实际测试证据为准；不要把“schema有字段”“脚本有名字”“健康检查200”当作功能完成。

## 5. 当前实现地图

| 范围 | 当前实际情况 | 优先检查入口 |
|---|---|---|
| 登录/身份 | 已有BFF cookie/session；新增注册、家庭加入/邀请、成员、多宝宝store/UI仍在整合 | Web `lib/growdesk/{session,bridge-identity,bridge-endpoints}.ts`、`stores/slices/auth.ts`、`app/family/page.tsx` |
| 核心照护记录 | feeding/sleep/diaper/food适配已重构，分页/日期/详情/版本helper和日报聚合尚有失败 | `lib/growdesk/record-*.ts`、各route、`RecordEditDialog.tsx` |
| 医疗/图片 | 新增items正式字段、私有S3上传/读取、附件归属与头像绑定、医疗详情/版本化删除 | 两库medical与attachment相关文件，migration013 |
| 知识/绘本 | 迁入旧JSON参考资料，发育/活动/指南可读；绘本状态进入PG，含family change | API `knowledge/`、`knowledge-routes.ts`、`book-routes.ts`；migration014 |
| 天气 | 旧逻辑迁入后端，加超时/缓存；类型检查尚未修好 | API `services/weather-service.ts` |
| AI/后台任务 | 新增provider、chat processor、持久事件/SSE、worker/scheduler启动；未完成联合验收 | API `ai-service.ts`/`ai-routes.ts`、`apps/worker/src`、`apps/scheduler/src` |
| 营养补剂 | 仍缺大量契约/持久化/界面接线；不是已完成 | `nutrition/products/schedules/analysis`、后端nutrition contract/repository |
| 疫苗/food/growth/通知 | 部分旧适配存在，但完整字段/操作和旧UIshape需要逐项核对 | 相应Web routes、store与后端services |
| MCP/OAuth/PAT | 新后端正式实现不齐；Web保留完整旧实现但新模式仍应阻断 | Web `lib/mcp/server.ts`、oauth/token入口；后端mcp契约 |

关键：`proxy.ts` + `lib/growdesk/bridge-policy.ts` 是method级防漏栅栏。注册/家庭/invite/日报已有部分新handler却尚未统一加入允许清单。**应在真正接通并验证后补allowlist，不可直接删除栅栏。**

## 6. 最先解决的已知失败

### A. Web typecheck失败

见 `evidence/tasks/WIP_WEB_PREVIEW/typecheck.log`：
- `stores/useBabyStore.ts` 与records slice的 `saveBaby` 参数不一致，特别是 `avatarUrl` nullable；同时核对familyId/gestationalDays不能在调用链丢失。
- `tests/unit/growdesk-records-preview.test.ts` 中 `DatedRecord.id` 与泛型fixture类型不正确。

### B. 记录单测3/5通过，2个日期边界失败

见 `record-tests.log`：错误结果包含本应排除的 `test_feed_1`、`test_sleep_boundary`。
要检查代码与fixture两边的时区假设、家庭timeZone字段、跨日睡眠区间及起止边界；不能简单改预期/删断言使之变绿。若测试本身有误，可修，但说明依据并覆盖真实业务边界。

### C. 后端build失败

见 `build.log`：`weather-service.ts` 的 `.json()` 返回unknown，必须添加合适的响应验证/类型收窄。不要以any或ts-ignore掩盖未经校验的外部输入。

### D. 测试通过的范围有限

- 新增知识/AI provider本地fixture：7/7通过，日志 `unit-tests.log`。
- 本机真实隔离PG/S3医疗测试通过：items/附件/归属/附带测量/409删除/时间线。
- 本机真实隔离PG绘本测试通过：状态持久化/权限/409/家庭change feed。
- **完整浏览器、全站Web+API、真实外部AI/voice、完整worker队列、迁移演练尚未通过。**

## 7. 后续工作建议：按能独立验证的块交付

你可以基于源码调整顺序或发现更好的设计，不需要机械服从下面的文件组织。

1. 先把现有WIP收敛到可编译、当前回归通过；补真实登录->家庭/宝宝->记录CRUD->日报->编辑/删除的闭环。
2. 完成多家庭/多宝宝选择、onboarding、撤权后的缓存清理；上传必须明确归属。保留旧UI行为。
3. 补营养：奶粉完整营养字段/isActive/isDefault/多奶粉；补剂产品与计划模型、打卡productId/date/time/dose/unit；分析保持旧确定性引擎能力。当前新库仅有简化supplementName/amount，不能冒充等价。
4. 补疫苗参考资料/选择/剂次状态、food library/plans、growth、通知等实际使用入口，核对读写DTO逐字段兼容。
5. 完成Web AI与持久任务：会话隔离、提交/取消/状态、SSE游标恢复、确认动作事务与幂等。现有confirm仅有限feeding create；voice和daily-summary processor明确不支持。不要伪造任务成功或AI内容。
6. 完成MCP/OAuth/PAT/统计。保留细粒度工具和既有来源标识，严格OAuth audience/PKCE/session约束；不要让Web BFF重新连接SQLite。
7. 校对契约路由注册、生成OpenAPI/SDK、增量migration和升级兼容性；安排联调/浏览器验收。
8. 全部通过后由宿主agent独立端口部署试用；真实数据迁移、最终增量对账、附件迁移和生产切换属于后续操作，不应夹带在代码安装脚本中。

若一次上下文无法做完全部，请交付完整的小块和准确剩余清单。不要宣称整个迁移完成。不要把大范围未验证重写打成一个无法审查的包。

## 8. 如果你能运行代码

请在自己的clone/worktree中工作。读各库AGENTS，生成Prisma client，再按依赖build。使用test_或e2e_账号、明确test_家庭/宝宝；不得向真实家庭造测试数据。

Web单测配置可以从公开 `.env.test.example` 复制。不要读取生产.env。后端需要Node24；如无PG/Redis/S3环境，可运行适用纯单测并把集成验收留给宿主。

建议提交下列证据：实际命令、退出码、测试数量、环境隔离说明。区分HTTP fixture、Fastify inject+真实PG、真实进程、浏览器测试，不要混为E2E。

本机环境、已有容器/端口、命令见详细HANDOFF；它们只是宿主的信息，不应硬编码为通用生产默认。新测试要验证目标身份，不能“连接不上测试库就找本机默认库”。

## 9. 如果你不能运行代码

仍可根据完整源码完成实现、契约和增量migration，编写有意义的测试，做静态交叉检查。明确标记 **NOT_RUN**，给出宿主可直接执行的验证命令及预期业务断言。

不要捏造PASS、CI链接、日志、截图或功能已部署；不要删除环境测试来消除红灯。对运行期未知项列清楚需要宿主验证什么、失败说明什么。

你可以从PR交付，也可以提供下面的patch包；不需要能访问用户服务器或生产密钥。

## 10. PR交付格式

- 每个仓库单独PR，目标分支 `codex/wip-growdesk-web-integration-20260914`（不是main）。提交标题/描述明确当前任务范围。
- 两库交叉链接，列明实际base SHA、head SHA、配套契约/migration、是否必须一起合并。
- 描述具体修复前后行为，测试状态与未完成项。源码/测试/迁移/生成契约一起审查；不包含node_modules、.next、dist、数据库、私钥、生产.env、运行日志中敏感信息。
- 不在PR附带自动部署/重启/生产数据库迁移。宿主会先审查并在隔离环境验证。

## 11. Patch包交付格式（推荐兼容离线ChatGPT）

```text
growdesk-integration-patch/
  HANDOFF_RESULT.md
  manifest.json
  patches/
    baby_panel_for_cecilia.patch
    growdesk-server.patch
  tests/                  # 可选：真实运行日志或NOT_RUN说明
  files/                  # 可选：二进制/无法表示为文本diff的完整文件
```

`manifest.json`至少包含：

```json
{
  "task": "具体任务范围",
  "repositories": [
    {
      "repository": "baby_panel_for_cecilia",
      "baseCommit": "实际检出SHA；离线则填写提供的精确code baseline",
      "patch": "patches/baby_panel_for_cecilia.patch",
      "patchSha256": "补丁文件SHA256",
      "files": [{ "path": "仓库内相对路径", "action": "modify", "baseBlobSha": "如能获取则填写原Git blob SHA，否则null", "resultSha256": "如能计算则填写，否则null" }]
    }
  ],
  "validation": { "status": "PASS / FAIL / NOT_RUN / PARTIAL", "commands": [] }
}
```

若无法计算哈希，填null并说明原因，不要编造。另一个仓库同样列出。

- 补丁必须是相对各自仓库根的标准unified diff，含新增/删除文件。能运行Git时，推荐 `git diff --binary BASE_COMMIT HEAD > repo.patch`；无Git时也可输出标准diff。
- 若有二进制，使用Git binary patch或完整文件+SHA256。不要只发零散替换片段/截断文件。
- `HANDOFF_RESULT.md`说明已做/未做、准确base、改动清单、测试结果、合并顺序、migration顺序、已知风险和后续验证。
- **不要包含自动应用、rm/reset/clean、重启服务、导入生产数据或读取.env的脚本。** 宿主会用 `git apply --check` 检查，再按实际上下文合并；base不一致时必须人工判断，不能盲目覆盖。

## 12. 宿主agent收到PR/patch后的流程

核对两库SHA及已有未提交改动 -> 在独立分支/副本审查diff和manifest -> 保留当前代码而非清空覆盖 -> 分别应用 -> 生成client/build/contract检查 -> 单测 -> 明确test_租户的真实PG/Redis/S3集成 -> 浏览器测试 -> 记录验收。

所有WIP修复都留在隔离副本。未验证的改动不得直接落到运行目录；生产3088/3180不停止、不重启、不用来跑测试。试用部署完成后把新地址交用户，正式切换等待用户决定。
