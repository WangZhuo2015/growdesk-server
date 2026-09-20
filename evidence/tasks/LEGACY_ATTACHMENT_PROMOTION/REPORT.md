# Legacy attachment promotion slice — IMPLEMENTED_NOT_REVIEWED

日期：2026-09-19

本切片只实现隔离历史归档的只读附件映射规划器：
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

后续独立切片仍需在 owned PG/MinIO 中完成：验证 `legacy_import.import_batches` /
`import_rows` 和当前 canonical identity 的一致性；在受控对象存储中复制后重新流式
核对 size/hash/MIME；在同一个可重试、幂等的数据库事务里写 Attachment 与 promotion
receipt，并在对象核验成功后将 status 置为 `ready`；最后以同一事务更新 Growth、Medical、
Baby avatar、AI/语音引用并做逐文件对账。对象存储复制与 PostgreSQL 提交本身不是单一
原子操作，必须另有可恢复的 outbox/reconcile/quarantine 处理。
