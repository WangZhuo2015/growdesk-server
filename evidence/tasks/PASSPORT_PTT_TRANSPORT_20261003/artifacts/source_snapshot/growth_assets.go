package growdesk

import _ "embed"

// GrowthStandardsSource is the frozen public reference dataset, not executable
// TypeScript and not patient data. Native parsing validates every series; the
// reference tree and its exported HTTP contract remain unchanged.
//go:embed packages/domain/src/who-growth-standards.ts
var GrowthStandardsSource []byte
