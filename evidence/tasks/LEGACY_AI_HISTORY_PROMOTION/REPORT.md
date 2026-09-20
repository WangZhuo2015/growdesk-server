# Legacy AI history promotion — REVIEWED_LOCALLY_NOT_DEPLOYED

任务：在不调用 provider、不暴露原始 provider payload 的前提下，把 legacy AI 私有会话、消息和历史异步任务接入现有 GrowDesk canonical run 模型。

状态：REVIEWED_LOCALLY_NOT_DEPLOYED

基线：当前工作树 `codex/web-parity-20260919`；materializer 与在线 scope 修复已拆分提交并完成独立 review。

## 范围与映射

实现文件：

- `scripts/legacy-import/materialize_ai_history.py`
- `scripts/legacy-import/test_ai_history_materializer.py`
- `scripts/legacy-import/test_ai_history_materializer_integration.py`

已映射：

- `AiChatSession` → `public.ai_sessions`，保留 source ID、user/baby scope、标题、context 和时序。
- `AiChatMessage` → `public.ai_messages`，保留 source ID、role、正文和时序；`toolsJson` 只写 SHA-256/长度证明，原串仍只在 `legacy_import`。
- `AiJob` → `public.task_executions` + `public.ai_runs` + `public.ai_run_events`。旧 job 没有 session ID，因此为每个 job 建立由 source ID SHA-256 派生的 user-private synthetic session，并在 receipt 中标记原因；没有创建 `task_outbox`，历史 job 不会被新 worker 重跑。`done` 映射为 `succeeded`，`failed` 映射为 `failed`，未完成 `processing` 明确终止为 `failed/LEGACY_INCOMPLETE_NOT_RESUMED`。

每个目标实体都写入 `legacy_idempotency_mappings` receipt，含 source row hash、mapping version、完整目标 snapshot 和 snapshot hash。目标行或 receipt 已存在但不完全一致时整批拒绝；同一批重放为幂等 no-op。所有 SQL 在同一事务和 advisory lock 中执行。

## Quarantine / 未猜测映射

下列表没有安全的当前 canonical 承载，因此只保留在 `legacy_import`，由 materializer 的机器可读报告列为 quarantine：

- `AiArchive`（冻结 source inventory 为 502 行）：原始文本/图片/音频需要 Attachment、对象存储 hash/size/owner ACL 完整 promotion，不能复制成 `AiRun` 文本或未经授权的 URL。
- `AgentVoiceLog`（冻结 source inventory 为 9 行）：当前 schema 没有等价 voice-history 表，不能伪装成 chat message。
- `RecordSnapshot`（冻结 source inventory 为 7 行）：它是撤销/恢复前的业务快照，不是 `SyncSnapshot`，不能互换语义。
- `AiJob.inputArchiveId`、`AiJob.imageUrl` 和 `AiChatMessage.image` 只留下 hash/引用状态；前两者标记 `quarantined_until_attachment_promotion`，后者直接拒绝本批，避免 legacy URL 绕过私有附件授权。

`resultJson`、`errorMessage`、`toolsJson` 和 provider 相关内容不会写入 online target；目标只保留 hash、长度、source ID、状态和显式 redaction 标记。原始内容仍由受控 `legacy_import.import_rows` 保存，未出现在本报告或测试输出中。

## 验证

测试数据仅使用 `test_` 用户、家庭、宝宝和记录；未连接生产、旧 SQLite、3088、真实 AI 或真实对象存储。

| 命令 | 结果 |
| --- | --- |
| `python3 -m py_compile scripts/legacy-import/materialize_ai_history.py scripts/legacy-import/test_ai_history_materializer.py scripts/legacy-import/test_ai_history_materializer_integration.py` | 退出码 0 |
| `python3 scripts/legacy-import/test_ai_history_materializer.py` | `AI history materializer pure tests PASS (9)` |
| `python3 scripts/legacy-import/test_ai_history_materializer_integration.py`，由一次性隔离 PostgreSQL 18 / `test_growdesk_integration` / `test_runner` manifest 驱动 | `AI history materializer owned PostgreSQL integration PASS` |
| `MINIO_BIN=/private/tmp/growdesk-minio-tools-20260919 python3 scripts/test-integration.py --legacy-care --s3` | PASS，包含全量 migration、AI history promotion、API、Redis、MinIO 与附件回归 |

owned PG 集成覆盖：目标 snapshot exact-match、重复执行、receipt 冲突拒绝、provider/tools hash-only、`processing` 不创建 outbox、source row hash mismatch，以及已执行一条目标语句后第二条失败时的整批回滚。独立 review 重新在一次性 owned PostgreSQL 18（`test_growdesk_integration` / `test_runner`）上完成了同一 focused integration，仍为 PASS。

## 未完成与 review 重点

未完成项是上述 quarantine 表及 attachment/voice/snapshot canonical 设计；本切片没有把它们标为已迁移，也没有生成生产导入 SQL。Daily Summary 没有 legacy canonical model；旧日报输出若存在于 `AiArchive`，随 `AiArchive` quarantine，等待独立 summary/attachment 决策。

交给 reviewer 最应检查：

1. `AiJob` synthetic session 的 owner/baby scope 和历史 `processing` 的终态策略是否符合批准的迁移决策。
2. 所有 target snapshot/receipt 条件是否覆盖新增字段，且迟到 worker 无法从历史导入重新领取任务。
3. quarantine 边界是否应在 Attachment、Voice History、Record Snapshot 任务中扩展 canonical schema 后重新打开。

## 独立 review 结果

- materializer 生成的 target-conflict 分支已用纯测试锁定：同一 target ID 的不一致快照必须进入 `RAISE EXCEPTION`，不能生成空的 `ELSIF` 分支；synthetic session ID 与真实 `AiChatSession` ID 冲突时也已验证 fail-closed。
- `apps/api/src/services/ai-service.ts` 已补齐 baby-scoped session/run 的在线访问检查，并拒绝 `kind = legacy_ai_job` 的 retry，避免历史 `processing` 终态被重新放入 `task_outbox`。这部分需随 API 集成套件一并验收。
- 当前 focused owned PostgreSQL 验收没有连接生产库、旧 SQLite、真实 provider 或真实对象存储；报告中的 attachment、voice history、undo snapshot 仍是 quarantine，不能以本切片的 hash receipt 代替 canonical promotion。

回退影响：删除本批 `legacy_idempotency_mappings`、`ai_run_events`、`ai_runs`、`task_executions`、`ai_messages`、synthetic/source `ai_sessions` 和对应 raw test batch 即可回退；未触碰生产数据。
