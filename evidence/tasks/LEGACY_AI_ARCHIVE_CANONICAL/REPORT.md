# Legacy AiArchive canonical private archive

任务：把旧 Web `AiArchive` 迁移到可审计、私有、按租户授权的 PostgreSQL canonical 表，并把二进制引用接入私有 `Attachment` promotion。

状态：IMPLEMENTED_NOT_REVIEWED

基线 HEAD：工作区已有 022 voice / 023 snapshot 并行改动；本切片新增 migration `202609190024_ai_archive_entries`，未提交、未部署。

实现内容：

- `public.ai_archive_entries` 保留旧行的 source batch/table/id、source hash、kind、file path、content、content hash、byte size、createdAt 以及显式 user/family/baby ACL。
- 旧 `AiArchive` 没有 owner 外键；只有快照内显式 scope 或唯一、可验证的 `AiJob.inputArchiveId` 关联才会映射为 `mapped`。缺 owner、owner 冲突、无效 scope 的行仍写入 canonical 表但标记 `quarantined`，没有在线 DTO 或公开 URL。
- quarantine 行只保留 plaintext 的 source hash/size（以及受限 `legacy_import` 中的原始快照）；canonical `content` 对未证明 owner 的行置空，并记录 `contentRedacted`，避免在第二张表重复暴露私人内容。
- `filePath` 行必须有同一 source batch、source row hash、content hash/size 的 attachment promotion receipt；SQL 执行时再次检查目标 `Attachment` 为 ready、未删除、同 family/baby、同 hash/size。缺 receipt 的二进制行 fail closed 为 `ATTACHMENT_NOT_PROMOTED`。
- 每批 SQL 使用 transaction advisory lock、immutable source-row hash 校验、目标快照 hash、`LegacyIdempotencyMapping` receipt；重放必须完全相同，篡改或冲突会整批回滚。
- `attachment-promotion-cli.ts` 是对象存储/数据库的显式写边界；默认只写 `execution_required` 报告，必须传 `--execute` 才能执行，输出 0600 机器可读报告。
- 已映射归档的 user/family/baby/Attachment 外键使用 `RESTRICT`；删除前必须经过显式 quarantine/retention 流程，避免 `SET NULL` 后仍把无 ACL 行标记为 mapped。当前切片不改变账号删除流程，reviewer 需要把这个门禁纳入最终删除编排。

改动文件：

- `prisma/schema.prisma`
- `prisma/migrations/202609190024_ai_archive_entries/migration.sql`
- `scripts/legacy-import/materialize_ai_archive.py`
- `scripts/legacy-import/test_ai_archive_materializer.py`
- `scripts/legacy-import/test_ai_archive_materializer_integration.py`
- `scripts/legacy-import/attachment-promotion-cli.ts`
- `scripts/test-integration.py`（在 `--legacy-care` owned runner 中接入 focused PG 检查）

验证命令（均为隔离环境）：

- `python3 scripts/legacy-import/test_ai_archive_materializer.py` → PASS (5)
- `npx prisma validate --schema prisma/schema.prisma` → PASS
- `npx prisma generate --schema prisma/schema.prisma` → PASS
- `npm run backend:typecheck` → PASS
- `npx eslint scripts/legacy-import/attachment-promotion-cli.ts` → PASS
- 受 `BOOT02_RUN_FILE` 管理的临时 PostgreSQL 18、`test_runner`、`test_growdesk_integration`：完整 migration chain + `python3 scripts/legacy-import/test_ai_archive_materializer_integration.py` → PASS；证明 2 mapped/2 quarantined、重放不重复、目标篡改拒绝、source hash 错误拒绝并保持整批原子性。

quarantine：

- focused fixture 的 owner 缺失为 `OWNER_UNPROVEN`，owner 冲突为 `OWNER_CONFLICT`，无 attachment receipt 为 `ATTACHMENT_NOT_PROMOTED`；这些行仍保留 source/content hash 元数据，不会被伪造为已授权数据。
- 已有 legacy source inventory 记录 502 个 `AiArchive` 行；尚未对新的最终停写快照运行全量 attachment planner、promotion、archive materializer 和逐行对账，因此不能在本报告中声称真实 502 行已映射或 quarantine 数量已最终确定。

未解决/交 reviewer 的 3 处：

1. 检查 024 migration 的 `RESTRICT` owner/attachment FK 与目标删除编排一致，并确认 022/023/024 顺序不与其他并行 migration 冲突。
2. 检查真实 snapshot 上 `AiJob.inputArchiveId` 的 owner 证明策略；多家庭、无关联的输出归档必须保持 quarantine，不能按“家庭第一个成员”猜 owner。
3. 在最终停写快照上先运行 attachment planner/CLI，再运行本 materializer，并核对 mapped/quarantine、Attachment hash/size、source receipt 和 target count；本切片未连接生产。

回退影响：migration 只新增表和索引，没有改写旧表；失败时事务回滚。删除/回退 migration 只能在确认没有引用后由数据库 owner 执行，本切片没有执行 destructive rollback。
