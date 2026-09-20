# Legacy reference golden

Status: `REVIEWED_LOCALLY_NOT_DEPLOYED`

The public development, activity, feeding-guideline, and source-reference projections were compared with the versioned JSON files in the clean legacy production baseline commit `0b3e87c202b7420cb2ad2e1ee5d24cab3ceea156`. Compatibility-only aliases were removed before hashing.

The resulting fixed golden checks cover 119 milestones, 32 warning signs, 25 activities, 4 feeding guidelines, 59 unique source references, and the release metadata. The test uses canonical recursive key ordering and SHA-256, so a count-preserving field or value change also fails.

Validation:

- `node --import tsx --test tests/unit/legacy-reference-golden.test.ts` — 2 passed.

This evidence covers versioned public reference data. Family records, vaccine rule tables, books, attachments, and production cutover counts have separate gates.
