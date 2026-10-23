# Family record push content

Status: **IMPLEMENTED_NOT_REVIEWED**.

The notification outbox now carries a versioned `{version,title,body}` content snapshot created inside the care-record write transaction. The title names the authenticated actor, baby, operation, and record type; the body renders the persisted fields for feeding, sleep, diaper, food, supplement, and growth records. Timestamps use the family IANA time zone and explicit UTC offset. Notes retain internal whitespace and line breaks. Inbox rows and APNs/Web Push bodies use the snapshot. Web Push stays within the 3072-byte budget and clips only the wire body with `…点击查看完整内容`; stored inbox text stays complete. Event identity, metadata event key, tag/topic, and subscriptions keep their existing values.

Pending pre-snapshot tasks remain decodable. The worker renders current scoped details only when the record version still equals the event version. A changed or missing row receives an explicit old-version fallback without future record fields. A legacy generic inbox row is upgraded to the resolved snapshot while an already detailed row is preserved.

## Validation

- RED: the new focused tests first failed to compile because the snapshot and bounded wire helpers were not implemented. After the formatter existed, field assertions exposed missing normalized zero formatting, sleep interval labels, and enum output; those assertions were corrected and now pass.
- GREEN: `GOCACHE=/private/tmp/gocache-growdesk-push-details go test ./internal/backend -run 'TestFamilyNotification|TestRenderFamily|TestLegacyFamily|TestFamilyPushPayload|TestNativePushEndpointIsolation|TestNativePushSubscriptionAndVAPID' -count=1` passed.
- `git diff --check` passed.
- `TestNativePushTransportCancellationAndRedirect` was separately attempted but could not bind its existing `httptest` listener in this sandbox (`operation not permitted`). The requested isolated HTTP/worker/decryption checks are owned by the parallel runtime runner and remain a separate evidence layer.

## Review boundary

The formatter and wire-budget tests exercise all six record types, enum labels, zero values, timezone offsets, multi-line notes, old-version/missing-row fallback, immutable task serialization, and Unicode clipping. This is implementation evidence only; it does not establish independent review, production delivery, or deployment.
