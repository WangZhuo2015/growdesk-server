# GrowDesk 服务端开工入口

完整计划的唯一主本：[迁移总计划](docs/plan/IOS_MIGRATION_PLAN.md)。

## 当前状态

2026-09-11：已保留用户创建的根 package.json、tsconfig.json 与 `@growdesk/domain`、`@growdesk/database`、`@growdesk/contracts` 骨架。已有 scripts 声明不代表实现完整或测试通过；尚未安装、构建、迁移或验收。先核对实际文件，禁止重新初始化覆盖工作区。

- 服务端：本仓库根；不再创建嵌套 backend 目录。
- iOS：同级 `../growdesk-ios`，独立 Git/Xcode 工程。
- Android：同级 `../growdesk-android`；本轮计划不包含 Android 实现任务。
- 旧 Web：`../baby_panel_for_cecilia`，用于只读参考；兼容改造须作为独立任务追踪。

## 现在怎么开始

1. 读取 [Agent 手册](docs/plan/implementation/06_AGENT_EXECUTION_PLAYBOOK.md) 与根 AGENTS.md，记录当前分支、HEAD（无提交时记 UNBORN）和已有未提交文件。
2. 先领取 BOOT-01，检查既有骨架、工具链、依赖兼容性，锁定实际可构建版本；不提前执行依赖尚未实现的根脚本。
3. 完成证据与独立 review 后，继续 BOOT-02、BE-01，其他任务按手册依赖图推进。iOS 的 IOS00_BASELINE 可独立准备；协议集成等待已接受契约。
4. 一次只交付一个任务。报告放在当前仓库 `evidence/tasks/<TASK-ID>/REPORT.md`，实现者标记 IMPLEMENTED_NOT_REVIEWED，独立 review 才能 ACCEPTED。

直接给实现 Agent：

```text
请在 growdesk-server 完成 docs/plan/implementation/06_AGENT_EXECUTION_PLAYBOOK.md 的 BOOT-01。
先读 AGENTS.md、总计划与任务引用章节，核对并保留已有未提交骨架。
按任务补齐工具链验证与版本锁定，运行必要的隔离验证并提交脱敏证据报告。
不要重新初始化仓库，不连接生产，不修改旧 Web，不替后续任务做大范围实现。
完成后报告 IMPLEMENTED_NOT_REVIEWED、改动文件、验证结果和待 review 项。
```

## 跨仓库交接

BOOT/BE/DB/OPS 默认属于服务端，IOS 属于原生端。BE-12 的旧 Web 兼容改动属于旧 Web 仓库，单独记录基线、diff 与证据。需要改多个仓库时逐一明确允许路径，禁止把相邻仓库文件一起拷入当前仓库。

API schema 权威在服务端 `packages/contracts/src`，导出 `contracts/openapi.json`。iOS 的 IOS01 将已验收版本复制到自身 `Contracts/openapi.json`，并在 `Contracts/source.json` 记录服务端仓库标识、commit、契约版本和 SHA-256。iOS 生成客户端只读取固定快照；本地可以从相邻仓库导入，但 CI 不依赖该目录存在，也不使用浮动分支或软链接。服务端契约变动先检查兼容性，分别提交服务端与 iOS 更新并互相记录 commit；不得静默更新客户端快照。具体快照与脚本由相应任务实现，本次仅建立文档。
