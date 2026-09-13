# GrowDesk 服务端开工入口

完整计划的唯一主本：[迁移总计划](docs/plan/IOS_MIGRATION_PLAN.md)。

## 当前状态

2026-09-11：BOOT-01 工具链与隔离环境已完成本地复核，见 `evidence/reviews/2026-09-11-r3/REVIEW.md`。当前推进 BOOT-02 正式工作区与测试基础，业务 API、数据库模型、同步服务尚未完成。保留所有未提交修改，不重新初始化。

2026-09-12：本轮补齐真实 PG/Redis `/health/ready`、独立容器部署与现有 singbox nginx 接入模板。基础服务已部署到 `https://ampere.zwang.fun:8443`，PG/Redis真实健康及公网TLS检查通过；当前云业务仍未完成。最新状态见 [CLOUD_BOOTSTRAP 报告](evidence/tasks/CLOUD_BOOTSTRAP/REPORT.md) 和 [部署手册](deploy/HOST_RUNBOOK.zh-CN.md)。

- 服务端：本仓库根；不再创建嵌套 backend 目录。
- iOS：同级 `../growdesk-ios`，独立 Git/Xcode 工程。
- Android：同级 `../growdesk-android`；本轮计划不包含 Android 实现任务。
- 旧 Web：`../baby_panel_for_cecilia`，用于只读参考；兼容改造须作为独立任务追踪。

## 当前优先路线：保留 Web，与 iOS 共用后端

2026-09-12 用户已确认统一后端方案。执行拆分见 [09 详细任务计划](docs/plan/implementation/09_WEB_IOS_SHARED_BACKEND.md)，给 Gemini 的首轮提示词见 [任务交接入口](docs/plan/GEMINI_SHARED_BACKEND_HANDOFF.md)。先做 SH-00 现状/调用/写入口盘点，再按依赖执行；允许提前开发隔离 Web 兼容层，正式切换仍保留 BE-10/11 和迁移演练门禁。下文旧 BOOT/BE 入口用于核对前置，不是重做已完成工作。

## 现在怎么开始

1. 读取 [Agent 手册](docs/plan/implementation/06_AGENT_EXECUTION_PLAYBOOK.md) 与根 AGENTS.md，记录当前分支、HEAD（无提交时记 UNBORN）和已有未提交文件。
2. 先核对 `evidence/tasks/BOOT-02/REPORT.md` 的当前结果和未完成项；按门禁补齐 BOOT-02 后再进入 BE-01。不要重做已复核的 BOOT-01，也不要把脚本存在当成业务已实现。
3. 完成证据与独立 review 后，继续 BOOT-02、BE-01，其他任务按手册依赖图推进。iOS 的 IOS00_BASELINE 可独立准备；协议集成等待已接受契约。
4. 一次只交付一个任务。报告放在当前仓库 `evidence/tasks/<TASK-ID>/REPORT.md`，实现者标记 IMPLEMENTED_NOT_REVIEWED，独立 review 才能 ACCEPTED。

直接给实现 Agent：

```text
请在 growdesk-server 继续 BOOT-02；先读取 evidence/tasks/BOOT-02/REPORT.md 核对剩余项。
先读 AGENTS.md、总计划与任务引用章节，核对并保留已有未提交骨架。
按任务补齐工作区、隔离验证与 CI；完成 BOOT-02 的 review 门禁后再领取 BE-01。产品边界以计划 07 为准，登录或联网不得自动开启同步。
不要重新初始化仓库，不连接生产，不修改旧 Web，不替后续任务做大范围实现。
完成后报告 IMPLEMENTED_NOT_REVIEWED、改动文件、验证结果和待 review 项。
```

## 跨仓库交接

BOOT/BE/DB/OPS 默认属于服务端，IOS 属于原生端。BE-12 的旧 Web 兼容改动属于旧 Web 仓库，单独记录基线、diff 与证据。需要改多个仓库时逐一明确允许路径，禁止把相邻仓库文件一起拷入当前仓库。

API schema 权威在服务端 `packages/contracts/src`，导出 `contracts/openapi.json`。iOS 的 IOS01 将已验收版本复制到自身 `Contracts/openapi.json`，并在 `Contracts/source.json` 记录服务端仓库标识、commit、契约版本和 SHA-256。iOS 生成客户端只读取固定快照；本地可以从相邻仓库导入，但 CI 不依赖该目录存在，也不使用浮动分支或软链接。服务端契约变动先检查兼容性，分别提交服务端与 iOS 更新并互相记录 commit；不得静默更新客户端快照。具体快照与脚本由相应任务实现，本次仅建立文档。

## 当前产品决策：联网应用，可选择仅本机保存

账号与宝宝采用显式多对多关联，家庭管理和宝宝数据权限分别校验。见 [计划 08](docs/plan/implementation/08_ACCOUNT_BABY_RELATIONSHIPS.md)；不要给 User 添加唯一 activeBabyId 作为数据归属，也不要用家庭资格替代每个宝宝的授权。

以 growdesk-server/docs/plan/implementation/07_LOCAL_FIRST_OPTIONAL_SYNC.md 为准。本地保存只限制数据上传，不关闭网络或替代账号流程。协作/MCP 需要联网及相关云端数据授权；用户明确开启后才同步。在线 AI 的单次发送授权与全库同步分离。先推进后端 BOOT-02/BE-01；原生本地持久库不再只是云缓存。
