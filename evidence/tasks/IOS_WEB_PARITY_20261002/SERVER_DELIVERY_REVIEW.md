# Reviewed server contract delivery

Status: IMPLEMENTED_NOT_REVIEWED; no production deployment or acceptance claimed.

This branch combines the independently reviewed vaccine PATCH/AI replay fixes and recent-session account delete/export receipt fixes. After integration, full Go tests passed; normal TypeBox build/generate/check produced 112 paths, 160 operations, and 56 schemas with no difference from the committed OpenAPI. The vaccine integration runner passed 26 real HTTP checks and the account/reauth/export runner passed 107 against separate disposable PostgreSQL/Redis/MinIO stacks, with all cleanup flags true. Their current JSON results identify exact source revision, binary and source hashes. Previous results are retained.

Client handoff must pin this committed branch and regenerate via the existing Swift OpenAPI build plugin. Do not patch generated Swift DTOs. A previous local contract-build attempt failed because the isolated dependency overlay had no .bin; using the adjacent repository's already-installed TypeScript executable with this worktree's own @growdesk/contracts source fixed that tool-path issue. No source or dependencies were installed from production.
