# Sanitized validation diagnostics

These are resolved local validation failures from the isolated worktree. They contain no user data, provider credentials, or connection strings.

1. `python3 scripts/test-integration.py --suite all` before dependency installation exited 1: `sh: tsc: command not found`. Resolution: `npm ci` from the checked-in lockfile.
2. `python3 scripts/test-integration.py --suite all` after dependency installation exited 1: `src/routes.ts(...): error TS2353 ... 'query' does not exist in type 'RouteDefinition'`. Resolution: use the existing `querystring` route metadata field.
3. The next build exited 1 because `packages/database/src/generated/client.js` had not been generated. Resolution: `npm run backend:db:generate`.
4. The next owned integration run exited 1 because `contracts/openapi.json` did not yet match the canonical TypeBox schema. Resolution: `npm run backend:contracts:generate`, followed by the passing contracts consistency gate.

Final reruns passed: `python3 scripts/test-integration.py --suite all`, the focused `--suite mcp-oauth`, `npm run backend:contracts:check`, `npm run backend:typecheck`, and `npm run backend:lint`.
