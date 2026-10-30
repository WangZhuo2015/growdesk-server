# OpenAI 官方 API 配置

服务端支持 `GROWDESK_AI_PROVIDER=openai`，通过官方 Responses API 调用 `gpt-6-luna`。Go API/worker 和 TypeScript API/worker 均支持此配置。

当前仓库已准备被 Git 忽略的 `.env.openai.local`，直接引用你提供的 `.gpt` 密钥文件；未打开或显示密钥内容。把这些变量注入实际运行的 API 与 worker 进程环境。其他环境可使用 [配置模板](../deploy/openai.env.example) 并调整密钥文件的绝对路径。模板只包含 AI 配置，现有 PostgreSQL、Redis、对象存储和认证配置仍按原部署方式提供。

```dotenv
GROWDESK_AI_PROVIDER=openai
GROWDESK_AI_MODEL=gpt-6-luna
GROWDESK_AI_API_KEY_FILE=/home/ubuntu/Github/growdesk-server/.gpt
GROWDESK_AI_TIMEOUT_MS=60000
```

密钥文件应包含一行原始 key。进程启动后由代码读取，错误和日志不包含密钥内容。也支持直接设置 `OPENAI_API_KEY`。优先级为非空 `GROWDESK_AI_API_KEY`、非空 `OPENAI_API_KEY`、`GROWDESK_AI_API_KEY_FILE`；文件不存在、内容为空或格式无效均明确失败。未配置文件路径时，不会自动寻找或读取 `.gpt`。

官方地址默认是 `https://api.openai.com/v1/responses`，无需设置 `GROWDESK_AI_BASE_URL`。从第三方服务切换时，移除原来的 `GROWDESK_AI_BASE_URL` 与内联密钥变量，避免旧配置覆盖文件引用。官方模式不会读取第三方兼容配置的 `AI_API_KEY`。

未配置密钥时，请求返回未配置错误；不会自动切换供应商或返回演示答案。默认模型为 `gpt-6-luna`，默认请求总超时为 60 秒，可在 100–180000 毫秒内设置。推理强度使用模型默认值。请求设置 `store=false`；对话记录仍由 GrowDesk 的持久任务和会话流程管理。模型生成的写入动作仍为提案，需按现有授权和确认流程执行。

普通文本随供应商的流式片段逐步发送。JSON 结构化提案会等待完整成功响应，解析后一次性发送其中的正文，避免把 JSON 包装和未完成的动作显示为回答。

图片/PDF 使用 Responses 的输入格式。语音转录与播报使用独立音频模型，默认分别为 `whisper-1` 和 `tts-1`，可通过 `GROWDESK_ASR_MODEL`、`GROWDESK_TTS_MODEL` 配置。

第三方兼容接口继续使用 `GROWDESK_AI_PROVIDER=openai-compatible`（或 `compat`），配合自己的地址、密钥和模型。此前把 `openai` 当第三方别名的配置需要改成 `openai-compatible`。

2026-10-30 已部署默认模型切换：无已保存选择的聊天、建议、解析、OCR 与语音 agent 使用官方 API 的 `gpt-6-luna`；保留用户显式保存的模型/来源选择。交互日报默认 AMD `DeepSeek-V4.1-Flash`，仍可手动切换。

定时日报使用独立 PostgreSQL 持久任务 worker，固定 AMD；不会继承用户的交互选择。任务只处理完整的家庭本地昨日，并沿用每宝宝每日一份日报的协议：已有日报不重复付费生成，用户显式手动生成可替换该日版本。暂时失败持续指数退避重试；401/配置错误保留任务，以 10–11 分钟间隔等待修复；用户/家庭/宝宝权限错误停止。重试状态、目标日期和取消标记跨进程重启保留。网页单独显示定时报告与其生成时间，不混作当前统计。

生产启动器直接引用 `.gpt`；本地 `.env.openai.local` 不会被程序自动加载。已通过密钥文件引用执行官方 `GET /v1/models/gpt-6-luna` 并得到 HTTP 200，未查看密钥内容。源码支持 Go Responses/key-file provider；当前主 API 保留已部署的语音/TTS二进制，由启动器选择官方 Chat Completions 与 GPT-6 Luna。Web agent 工具调用使用 Responses，ASR/TTS 仍使用独立音频模型。

部署及回滚证据见 [任务报告](../evidence/tasks/OPENAI_OFFICIAL_API_20261030/REPORT.md)。

接口依据：[OpenAI Docs：GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Responses 流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)。
