// Package growdesk contains the immutable contract and migration inputs used by
// the native Go implementation. TypeScript remains an independent reference.
package growdesk

import "embed"

const ReferenceCommit = "f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4"

//go:embed contracts/openapi.json prisma/migrations/*/migration.sql
var Assets embed.FS
