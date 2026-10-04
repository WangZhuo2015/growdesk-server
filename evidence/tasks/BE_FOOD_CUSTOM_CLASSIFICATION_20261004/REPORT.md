# Food catalog custom classification

Status: `IMPLEMENTED_NOT_REVIEWED`. No deployment or complete iOS parity claim.

Food library HTTP responses previously omitted the persisted catalog classification while change-feed and snapshot projections included it. The Go HTTP DTO now returns `isCustom` directly from `food_items.is_custom`. The TypeBox FoodLibraryItem source declares the property optional for compatibility with older responses; an absent property means unknown and must not authorize editing. No ID-prefix inference or client-supplied classification is used. Normal contract generation retains 137 paths and 187 operations.

Normal backend build, contract generation/check, full Go tests/vet, typecheck, lint and 165 Node unit tests passed with zero failures/skips. The actual private PostgreSQL/Redis HTTP driver passed 50 calls and its bounded snapshot worker. It verifies all 45 reference rows return false, custom create/replay/clear/fresh read return true, and snapshot classification agrees. Existing authorization, optimistic conflict, feed rollback, shared status and digest checks remain exercised. All owned API/Redis/PostgreSQL processes and private data were removed.

`food-live.json` records the parent HEAD at the time of the dirty source run, exact delivery source hashes and binary hashes. These hashes independently matched before committing. The contract was generated normally from TypeBox, without editing generated JSON or Swift output. No production secrets/services/data, old Web database, external provider billing or real push was accessed.
