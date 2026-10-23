# PUSH_COPY_READABLE_20261007 — 内容实现证据

状态：**IMPLEMENTED_NOT_REVIEWED**。基线为 `6c2ca252dddc2bd6791c7f428d1ee225241c346e`。本报告只记录通知内容 renderer 的实现与本地测试；不表示生产已部署，也不修改旧通知、记录或 schema。

## 范围与行为

实现只修改：

- `internal/backend/family_notification_content.go`
- `internal/backend/family_notification_content_test.go`

通知快照仍使用版本 1。新事件生成家庭本地时间；秒为零时显示 `YYYY-MM-DD HH:mm`，非零秒保留秒和毫秒，不显示 UTC offset 或 IANA 名称。辅食时间和 `record_date` 在家庭本地日期相同时只显示一次；日期不同则保留两者。

辅食名称先使用同家庭或全局目录解析结果。旧记录中的可读名称继续显示；未解析的 `food_*`、UUID 等不透明标识显示为“未命名食物”，列表中每项均保留。`little/half/most/all` 显示为“少量/半碗/大部分/全部”。只解码已知的 `[growdesk-web-food:v1]` capsule，并按字段类型和值域白名单展示喜欢程度、进食状态、异常情况和异常备注。未知字段不展示；部分字段非法时保留同包可解码字段与人类备注，并给出提示；未知版本不猜测含义，也不把内部 JSON 放进通知。无标签的普通 JSON 备注保持原文，备注与异常文本保留内部换行。

补剂的 `[productId:...]` 前缀会通过当前家庭目录解析；无可读名称时显示“产品：未命名补剂”，隐藏内部 ID，并保留标签后的正常备注。配方奶产品 ID 也不再直接显示。

未修改 snapshot version、schema、记录存储、权限、事务、fence、订阅或 Web Push/APNs wire 结构。旧 pending 兼容和事件记录版本保护保持原样。

## RED 证据

先增加了 screenshot-shaped 测试，直接调用实际 `renderFamilyNotificationSnapshot`，使用 `测试家长`、`测试宝宝` 和合成时间/名称。执行时两个用例均按预期失败，退出码为 1：

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOFLAGS=-mod=readonly GOCACHE=/private/tmp/gocache-growdesk-push-copy \
  /Users/wangzhuo/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go test ./internal/backend \
  -run 'TestFamilyNotification(FoodCopyRendersLegacyObservationCapsuleWithoutInternalEncoding|SupplementCopyRemovesLegacyProductIDTagAndPreservesNote)$' -count=1
```

辅食失败输出包含 `2026-10-07 11:35:00 +08:00（Asia/Shanghai）`、重复的 `记录日期：2026-10-07`、`食物项 ID：`、`份量：most` 和完整的 `[growdesk-web-food:v1]` JSON。补剂失败输出包含 `产品 ID：test_internal_product_123` 与 `[productId:test_internal_product_123]`。

## GREEN 证据

冻结的两份 Go 文件通过 10 个聚焦测试，退出码为 0：

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOFLAGS=-mod=readonly GOCACHE=/private/tmp/gocache-growdesk-push-copy \
  /Users/wangzhuo/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go test ./internal/backend \
  -run 'Test(RenderFamilyNotificationSnapshotIncludesPersistedRecordDetails|LegacyFamilyNotificationFallbackNeverUsesLaterRecordVersion|FamilyNotificationSnapshotPreservesNoteWhitespaceAndLineBreaks|FamilyNotificationFoodCopyRendersLegacyObservationCapsuleWithoutInternalEncoding|FamilyNotificationSupplementCopyRemovesLegacyProductIDTagAndPreservesNote|FamilyNotificationFoodCopyPreservesValidFieldsBesideInvalidObservation|FamilyNotificationFoodCopyKeepsAbnormalNoteWhenStatusIsUnavailable|FamilyNotificationFoodObservationDecodeIsVersionScopedAndKeepsOrdinaryJSON|FamilyNotificationFoodNamesKeepCatalogLegacyAndFallbackItemsInOrder|FamilyPushPayloadClipsUnicodeWithinWireBudgetWithoutChangingInboxSnapshot)$' -count=1
```

覆盖截图字段与编码隐藏、多行备注、合法字段旁的非法观察值、异常备注保留、普通 JSON 与未知 capsule 版本、目录/旧名称/不透明 ID 混排及逐项 fallback、零秒与非零毫秒时间、日期去重，以及 wire UTF-8 预算和 inbox 原文不变。`git diff --check` 通过。

冻结输入 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `internal/backend/family_notification_content.go` | `5827e4dd05cef86c106ac6264dd1d4d6a2b443ca0bf6fa20d07e72cc923de32c` |
| `internal/backend/family_notification_content_test.go` | `bca77ba27917e0f5be438a04afb027556c60bf11ec02a3e52f73af65a0c321b5` |

## 其余验证边界

根代理报告完整 Go 测试已通过。隔离 HTTP/worker/Web Push runner 的新增内容用例仍由 runtime 代理按上述固定 SHA 验证；第一次 runner 尝试的旧 26 项通过，但新增事件未 fanout，期间检测到源码 hash 在执行中变化。runner 正在使用 `--notifications-only` fixture 重跑，因此本报告不把该项标为 GREEN。物理系统通知、历史通知撤回与生产部署均未验证。
