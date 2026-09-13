# Web integration fix — 服务端配套合并

日期：2026-09-13。状态：IMPLEMENTED_NOT_REVIEWED（本地验证通过，不表示生产发布）。

基线：`a9430c82a07c940571f386e9d0854f3830cac521`；用户提供 growdesk-integration-fix.zip，按 server 12 项原始 blob/context 校验应用。配套 Web 实现为 `8b780cc`、`66c1456`、`b1c3274`。

## 改动

- 喂养契约增加 mixed；追加第 12 个 migration，保留原有类型，不改旧 migration。重新生成 OpenAPI。
- 删除使用客户端 baseVersion；更新/删除/恢复在仓储绑定 id + familyId + babyId，堵住借有权限宝宝路径操作其他记录 ID 的漏洞。
- 列表允许内部读取 201 条，以判断公开 200 条分页是否还有下一页。
- CI 在检查前生成 Prisma/build，并监听 prisma/contracts 改动；移除重复 build，保留已有检查。
- 修正包中 feeding.test.ts 上下文误替换，只给两处 DELETE 请求传正确版本。
- 最终安全检查发现原 runner 将基础检查并入大列表，导致 lifecycle 的精确命令拦截失效。现将实例身份/基础检查独立放在迁移与并行业务测试之前，身份错误必须在业务 DDL 前中断；原 lifecycle 断言保留。

## 本地验证

- Node 24.14.1；db:generate、db:validate（12 migrations）、build、typecheck、lint：退出 0。
- contracts:check 首次发现需更新快照，执行 contracts:generate 后复检退出 0。具体命令与退出码见 command-results.json。
- backend:test:unit：85/85；连接 guard 与版本解析补检：19/19。
- 主 Agent 最终重跑 `python3 tests/integration/runner-lifecycle.test.py`：3/3，退出 0；日志中的预期失败是错误实例 token 拒绝用例，末尾 OK 表示门禁通过。
- 主 Agent 最终重跑 `npm run backend:test:integration`：基础 3 + 业务 192 + 新喂养回归 4 全通过，另有 legacy importer 演练通过；独占 PG18/Redis8 和临时目录已清理。
- 日志：[integration.txt](integration.txt)、[lifecycle.txt](lifecycle.txt)。所有回归使用 test_ 租户，未连接生产。

## 边界

保留此前未提交的 deploy/Migration.Dockerfile、LEGACY_IMPORT 证据与 ios_backup 文件，不纳入本次提交。未 push、部署、读取生产 secrets 或导入真实数据。GitHub CI 和 Web + PostgreSQL + 浏览器联合 E2E 未在本报告中认定通过。

上线必须先按正式迁移流程应用 `202609130012_legacy_mixed_feeding`，再部署 API 和配套 Web；本地测试通过不等于允许直接切换现有数据库写入方。
