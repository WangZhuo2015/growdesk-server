# 给 Gemini 的任务入口：Web 与 iOS 共用后端

完整执行计划：[09_WEB_IOS_SHARED_BACKEND.md](implementation/09_WEB_IOS_SHARED_BACKEND.md)。这是本轮唯一的任务拆分入口；02/03/07/08仍是协议与数据规则权威。

## 第一轮可直接复制的提示词

```text
请在 /Users/wangzhuo/Documents/GitHub/growdesk-server 执行 SH-00：Web/iOS共用后端的基线和调用清单。

先读：
1. 根 AGENTS.md、START_HERE.md。
2. docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md 全文。
3. 02_BACKEND_CONTRACTS.md、03_DATABASE_MIGRATION.md、06_AGENT_EXECUTION_PLAYBOOK.md、07_LOCAL_FIRST_OPTIONAL_SYNC.md、08_ACCOUNT_BABY_RELATIONSHIPS.md。
4. 当前云基础部署、LEGACY_IMPORT已有代码及验收文件，核对是否已提交/已review/已部署，不把它们混为一谈。

背景：保留旧Web界面，让Web通过Next同源兼容层调用GrowDesk API；iOS云端空间和MCP也使用同一API和PostgreSQL。iOS仅本机空间不自动上传。不能让Web直接连新PG，也不能长期双写SQLite与PG。

只读参考仓库：
- /Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia
- /Users/wangzhuo/Documents/GitHub/growdesk-ios
先读取各仓库AGENTS并记录HEAD/dirty状态。本轮只写growdesk-server的计划清单与证据，不改另两仓库。

第一轮必须交付：
- evidence/tasks/SH-00/REPORT.md：当前事实、已有缺口、执行命令与结果、准确的下一任务前置。
- docs/compat/web-call-inventory.csv：所有method/path、调用方、权限、DB读写/副作用、目标operationId、状态、测试入口。
- docs/compat/web-api-mapping.md：旧字段/状态码/日期小数/多宝宝/版本与幂等映射初稿。
- docs/compat/production-writers.md：Web路由以外的AI工具、MCP、stdio、worker、scheduler、维护命令等写入口；未知生产可达性明确标记。
- docs/compat/capability-status.md：已有实现、仅骨架、缺失、已验证、未验证分开列出；backend脚本指向not-ready时必须标为占位。

方法：优先rg扫描实际代码和依赖；不要只按页面或目录名猜测覆盖。当前旧Web仍是写权威；已导入的身份和1311行私有历史档案不等于新登录/业务/同步已完成。迁移脚本当前的非空库拒绝保护不能删除。

本轮不访问生产数据库、不读取部署秘密、不变更230服务/端口/nginx/定时任务，不执行部署、数据写入、push或reset/clean。
不得混入已有未提交Dockerfile、iOS备份转换器、迁移证据、Xcode或设计文件。仅stage本轮明确文件；完成后先提交这一部分。

最终报告标 IMPLEMENTED_NOT_REVIEWED，列基线/提交SHA、覆盖数量、具体缺口和SH-01的可执行范围。交独立review后再领取下一任务；不要在SH-00顺手开始写登录、CRUD或切生产。
```

## 后续每轮提示词模板

```text
请按 docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md 执行 <SH-任务ID>，只完成该任务卡范围。
读取前置任务报告和独立review结论，核对前置是真实实现且通过验收，而不是命令占位或文档声称完成。
明确本轮仓库、基线HEAD和已有dirty文件；按照任务卡输入、实现步骤、失败用例、隔离测试和退出条件工作。
在实际修改的仓库写 evidence/tasks/<任务ID>/REPORT.md，完成一部分先提交；跨仓库逐一记录commit和契约快照SHA。
尚未获得该轮具体部署范围时不触碰生产；已经明确授权的普通实现/测试不重复问确认。
不要降低权限、幂等、事务、字段保真或回滚要求来让测试变绿。无法完成的项目必须说明具体缺少什么和已完成证据。
完成后标 IMPLEMENTED_NOT_REVIEWED，给出diff、验证命令及退出码、遗留项，等待独立review。
```

## 建议给 review Agent 的提示词

```text
请独立验收 <仓库/SH-任务ID/实现提交>，按09计划任务卡和02/03/07/08的约束复查。
固定基线和提交，检查全部实际可达写入口、真实权限/事务/重试行为和契约变化，不能只阅读实现者报告。
重跑必要隔离检查；测试不触碰真实家庭数据。区分本地测试、模拟器、真机、迁移演练和线上结果。
对未映射字段、隐式首宝宝、DB直连旁路、重复副作用、同步丢变更、跨账号缓存和不可逆切回SQLite重点检查。
把可复现问题与修复后的复验结果写入仓库；无证据的能力不标ACCEPTED。review通过后明确允许领取的下一任务。
```
