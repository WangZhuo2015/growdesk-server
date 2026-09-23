package growdesk

import "embed"

// These files contain a single exported JSON literal, not executable runtime
// dependencies. The native loader decodes that literal without evaluating TS.
// Keeping the original frozen snapshot avoids a second, drifting dataset.
//go:embed apps/api/src/knowledge/legacy-reference-data.ts apps/api/src/knowledge/books-data.ts
var KnowledgeAssets embed.FS
