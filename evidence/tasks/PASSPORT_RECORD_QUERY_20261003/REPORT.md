# Passport voice record-query repair

Status: `IMPLEMENTED_NOT_REVIEWED`.

## Diagnosis

The authenticated Passport voice route transcribed the question and sent it to the configured assistant, but the provider request carried no ordinary baby-record context or query tool. In an isolated PostgreSQL baseline run, a committed, authorized test feeding row was absent from the captured provider payload: `provider_payload_has_authorized_record=false`. The foreign-family sentinel was also absent. The request therefore returned `test_no_record_context` rather than a data-backed answer.

## Change

Data questions now select an allowlisted record type and load authorized feeding, sleep, diaper, food, supplement, and/or growth context from a repeatable-read, read-only PostgreSQL snapshot. The loader revalidates the Passport device, membership, and baby-to-family scope; excludes soft-deleted rows; reports all-time count and earliest/latest local dates; and provides exact daily counts plus at most 12 recent samples per kind in a seven-local-day window. The serialized context is bounded to 24 KiB. User-entered notes are bounded and explicitly treated as untrusted data by the prompt.

Ordinary conversation, device-operation questions, advice, and explicit write requests do not load record rows. Imperative fragments such as “记录一下”, “记下来”, “新增”, “保存”, and “补记” are checked anywhere in the utterance before historical query cues; requests such as “麻烦记录一下宝宝昨天睡了多久” therefore remain writes. Explicit history verbs such as “查询”, “统计”, “看看”, or “列出” still select matching record types. Non-query turns read only the currently authorized family's IANA timezone in a separate read-only scope check, so the prompt can resolve “today/now” in family-local time. A provider action returned during a read-only data question is rejected before creating a confirmation card or mutating records.

## Evidence

`run-isolated-query-test.py` starts a disposable loopback PostgreSQL cluster on a nondefault port, applies tracked migrations under an owned `test_` non-superuser role/database, and uses local fake ASR/chat/TTS endpoints. It runs persistent PostgreSQL integration tests for authenticated query payload scope, all six record kinds, empty data versus errors, revocation, timezone boundary, exact daily totals, soft-delete and cross-family exclusion, truncation, rejected provider writes, non-data operations, and write-turn timezone handling.

Latest isolated result: all six PostgreSQL integration tests passed with `-race`; `pg-acceptance.json` records `guard_passed=true`, exit code `0`, cleanup counts `0|0|0|0`, and successful cluster removal. The focused intent and serialized-context-budget unit tests also passed.

## Remaining gates

This evidence does not establish whole-repository Go race/build status, Linux helper verification, deployment, or physical-device behavior. Those remain separate release gates.
