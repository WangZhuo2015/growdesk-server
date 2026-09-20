# Legacy attachment promotion slice — IMPLEMENTED_NOT_REVIEWED

日期：2026-09-19

本报告先记录隔离历史归档的只读附件映射规划器（第一阶段）：
`[scripts/legacy-import/attachment_promotion.py](../../../scripts/legacy-import/attachment_promotion.py)`。
它读取 `legacy.json`、`files.json`、`manifest.json` 和可选的隔离
`import_rows.json`（也可由调用方传入导出的 import rows），生成确定性的
Attachment ID、私有 object key、family/baby/uploader/purpose/MIME/size/SHA-256
映射，以及可机读的 promotion receipt/quarantine 报告。报告不包含归档绝对路径或
源 payload。

规划器在接受映射前会验证：

- `legacy.json`/`source.sqlite`（若存在）的 snapshot hash 和 `manifest` 来源一致性；
- manifest 路径必须落在 `public/uploads` 或 `data/archive`，拒绝绝对路径、`..`、编码路径、反斜杠和符号链接逃逸；
- 归档文件存在、是普通文件、大小和 SHA-256 与 `files.json` 一致，且不超过源/目标附件上限；
- family、baby、uploader 能从冻结 identity 和 active FamilyMember 证明归属，baby/family 不能跨租户；
- `import_rows` payload/source hash、旧 `contentHash`/`byteSize`、MIME/扩展名/文件签名之间没有冲突，扩展名本身不能替代文件签名；
- 旧 Baby/Growth/Medical/AiJob/AiArchive 引用能够推导安全 purpose；无法归属、缺失、hash/size/MIME 不符、重复或孤儿文件全部进入 quarantine。

成功 receipt 的 `result` 是 `planned`，`storageState` 是 `not_copied`，顶层
`storage` 固定为 `{database: not_written, objectStore: not_written}`。本切片没有
PostgreSQL/S3/MinIO 连接、复制、写 Attachment 行、引用更新或 ready 状态转换，避免
把文件检查误报成原子 promotion。

验证：

```text
python3 -m unittest discover -s scripts/legacy-import -p 'test_attachment_promotion.py'  # 9 passed
python3 -m unittest discover -s scripts/legacy-import -p 'test_*.py'                       # 23 passed
npm run backend:typecheck                                                                  # passed
git diff --check                                                                            # passed
```

测试 fixture 全部使用 `test_` 租户和临时归档；没有读取生产 DB、secret、真实归档或
对象存储。实现者状态保持 `IMPLEMENTED_NOT_REVIEWED`。

独立复核补充：拒绝仅凭允许的文件扩展名推断 MIME，并在解析前拒绝符号链接形式的
archive root；相应回归测试已包含在上述 9/23 项结果中。

第一阶段之后仍需验证 `legacy_import.import_batches` / `import_rows` 和当前 canonical
identity 的一致性；最后以独立事务更新 Growth、Medical、Baby avatar、AI/语音引用并做
逐文件对账。对象存储复制与 PostgreSQL 提交本身不是单一原子操作，必须有可恢复的
outbox/reconcile/quarantine 处理。

## Promotion runtime slice — 2026-09-19

本轮补齐上述边界中的最小 promotion/reconcile worker：
`[scripts/legacy-import/attachment-promotion-runtime.ts](../../../scripts/legacy-import/attachment-promotion-runtime.ts)`。
它只接受 planner receipt 和隔离归档根目录，先重验 archive-relative path、regular
non-symlink file、size/SHA-256 和 owner family/baby/uploader，再用流式读取复制到指定
私有 S3/MinIO bucket，并通过 HEAD + 流式 GET 重验对象的 MIME、size、SHA-256。对象已经
存在且完全一致时不重复写；不一致对象不会被覆盖，结果进入 machine-readable quarantine。

`Attachment` 与 `LegacyIdempotencyMapping(targetEntityType=attachment)` 在同一个
PostgreSQL transaction 中写入。source key、target Attachment ID 和 object key 都来自
planner 的稳定字段；事务内使用 PostgreSQL advisory xact lock 串行同源重试，重复执行会
返回 `replayed`，对象残留但数据库事务回滚后 `reconcile()` 会补齐 `ready` row 和 mapping。
任何 ownership、path、missing、hash/size/MIME、mapping conflict 或 DB 错误都 fail closed，
不会创建 Growth/Medical/Baby/AI 引用。测试注入的 commit failure 只用于证明事务回滚和
残留对象可恢复；生产调用不传 hooks。

owned PG18 + MinIO 验证：

```text
npm run backend:typecheck                                                                  # passed
npm run backend:build                                                                      # passed
npx eslint scripts/legacy-import/attachment-promotion-runtime.ts tests/integration/legacy-attachment-promotion.test.ts # passed
MINIO_BIN=/opt/homebrew/bin python3 scripts/test-integration.py --s3                       # passed; 2 S3 suites, full owned suite 215 tests
git diff --check                                                                            # passed
```

新增集成用例覆盖：同一 receipt 重跑幂等、错误 MIME/对象 hash quarantine、DB transaction
failure 后 object residue reconcile、baby/family 跨租户拒绝且不复制对象；所有用户、家庭、
宝宝、bucket 和归档均为 runner 创建的 `test_`/临时资源。runtime 仍是
`IMPLEMENTED_NOT_REVIEWED`，没有生产 DB/secret/归档访问，也没有 deploy wrapper 变更。

剩余边界：S3 PUT 与 PostgreSQL commit 不是跨系统原子操作；本切片以 receipt/quarantine
和显式 reconcile 提供恢复路径，尚未接任务队列/outbox、批量对账、源 `import_rows` DB
校验，亦未回填任何业务引用或处理人工 quarantine 决策。
