# Legacy asset migration audit — 2026-09-20

Status: **NOT_CUTOVER_READY**

This audit was performed read-only against the legacy production database and
the two approved source roots, `public/uploads` and `data/archive`. No test rows
were written to production. Two archive files were recovered from an immutable
rehearsal snapshot only after their SHA-256 and byte sizes matched the
`AiArchive` database records; they were restored with exclusive creation and
mode `0600`.

## Physical inventory after recovery

| Source root | Files | Bytes |
| --- | ---: | ---: |
| `public/uploads` | 22 | 46,044,255 |
| `data/archive` | 12 | 31,404,732 |
| **Total** | **34** | **77,448,987** |

## Explicit database references

The audited explicit attachment columns contain 45 unique paths. Twenty-two
paths currently resolve to files and 23 do not:

| Missing source | Paths |
| --- | ---: |
| `AiArchive.filePath` | 19 |
| `GrowthMeasurement.imageUrl` | 3 |
| `AiChatMessage.image` | 1 |
| **Total** | **23** |

No copy of the remaining missing basenames was found elsewhere on the server.
There are also 12 unreferenced physical files totaling 30,530,204 bytes. They
must remain quarantined until ownership and retention are reviewed.

## Embedded references

Attachment-like values also occur in fields that do not have a dedicated
attachment column:

- `RecordSnapshot.payloadJson`: 5 rows
- `AiJob.resultJson`: 3 rows
- `AiArchive.content`: 408 rows

The promotion planner now inventories these fields recursively, records only
hashes and JSON pointers in its report, and quarantines every unresolved path.
It does not guess a destination business field. In particular,
`AiJob.imageUrl` still has no approved canonical target relation and remains a
cutover stop.

## Cutover decision

Do not switch production traffic or delete the legacy file roots while any of
the 23 explicit references or embedded-reference quarantines remain. Generate a
fresh immutable archive and `files.json` manifest after the missing-source
decision is recorded, then rerun the attachment planner and require a clean
receipt before promotion.
