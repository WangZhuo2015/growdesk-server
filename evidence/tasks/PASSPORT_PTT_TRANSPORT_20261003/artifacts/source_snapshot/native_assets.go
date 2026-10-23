package growdesk

import "embed"

// NativeMigrations is a separate, additive history, never a replacement for
// the frozen reference schema. Applied explicitly by growdesk-migrate.
//
//go:embed native/migrations/*.sql
var NativeMigrations embed.FS
