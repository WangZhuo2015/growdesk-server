# Baseline captured for Passport short-turn ASR fix

Captured before edits in this task, preserving pre-existing workspace changes:

- `internal/backend/native_media.go`: reconstructed the exact pre-task workspace version by removing only this task's initial validator draft; the pre-existing bounded provider/local-audio changes are retained.
- `internal/backend/asr_local.go`
- `internal/backend/asr_local_test.go`
- `internal/backend/passport_asr_test.go`
- `internal/backend/asr_local_linux_test.go` was copied before this task's empty-transcript expectation update.

These files did not exist before this task and therefore have no pre-edit source snapshot:

- `internal/backend/native_media_test.go`
- `internal/backend/passport_short_turn_integration_test.go`
