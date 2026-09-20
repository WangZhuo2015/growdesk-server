# Legacy MedicalReport promotion — IMPLEMENTED_NOT_REVIEWED

日期：2026-09-19

本切片把冻结归档中的 `MedicalReport` 确定性投影到 canonical
`medical_reports` 与 `timeline_entries`。每条源记录核对 SHA-256、家庭、宝宝、
FamilyMember 与 BabyMember 归属；`recordedById` 缺失时仅选择同家庭的确定性管理员，
并在 receipt 中保留 fallback。`itemsJson` 必须是合法数组，数值必须有限；缺失 item ID
使用稳定 UUID。重放会核对目标快照，任一源行失败会回滚整批。

旧 `imageUrl` 当前只记录 `mapped_with_unresolved_attachment`，不会伪造 Attachment 或
公开 URL；后续引用回填必须等待附件 promotion 对账完成。

隔离验证：

```text
python3 scripts/legacy-import/test_medical_materializer.py                         # passed
MINIO_BIN=/private/tmp/growdesk-minio-tools-20260919 \
  python3 scripts/test-integration.py --legacy-care --s3                          # passed
```

owned PostgreSQL 18 集成覆盖精确 source hash、目标 receipt、幂等重放、跨家庭拒绝、
后续行失败的整批回滚和未决附件收据。统一 runner 同时通过现有后端全集、Redis 8 与
MinIO 测试；没有连接生产数据库、对象存储或读取生产 secret。

剩余边界：医疗图片仍需由附件 promotion 与引用回填切片完成。该切片尚未执行生产迁移，
状态保持 `IMPLEMENTED_NOT_REVIEWED`。
