# GrowDesk Agent 工作规则

请积极使用子代理；默认 Luna、Max 推理强度，任务必须有明确范围和验收。

- 先读 START_HERE.md 与当前任务引用的计划。一次领取一个任务，保留未提交文件；不重新初始化或覆盖用户已有骨架。
- 先检查脚本目标是否存在。package.json 有命令名称不等于实现已验收；不能吞掉退出码、跳过失败测试或用 mock 替代正在验证的事务/权限/并发行为。
- 所有测试用户必须使用 test_ 或 e2e_ username；测试家庭、宝宝必须明显带测试前缀，按任务创建独立租户并清理。禁止通过 findFirst 获取真实账号/宝宝，禁止向 Cecilia、好好或任何真实家庭写入演示、压测数据。
- 新服务端使用隔离 PostgreSQL/Redis/对象存储与虚拟外部 API 密钥；连接 guard 必须验证允许的 host/database/role 并拒绝生产及 SQLite fallback。禁止读取生产 secrets、测试连接生产、外部计费或真实推送。
- 旧 Web 的 prod.db/dev.db、3088 服务不能用于测试。旧 Web 测试只在该旧仓库遵循自己的 AGENTS，使用 dev_test.db/3089 和 npm run test:api:server；不要在新服务端复用旧 SQLite 配置。
- LLM 或客户端提供的 userId/familyId/babyId 不构成授权。后端必须从验证后的 session/Bearer 解析 principal，并检查家庭和宝宝归属。MCP OAuth audience 严格绑定 MCP，PKCE 强制 S256，code 原子单次兑换。
- 实现、review、生产迁移和部署是不同状态。任务完成附 diff、必要隔离测试及 evidence 报告；实现者只能标 IMPLEMENTED_NOT_REVIEWED，不能自称 ACCEPTED 或已上线。
- 核心协议以计划 02 为准，功能范围以 04 为准，任务依赖与验收以 06 为准。明确领取任务后可完成范围内普通实现与可逆修复，不重复索要确认；超范围冲突给出具体证据。
