import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GOLDEN_NOW = "2026-09-19T12:00:00.000Z";

/** Control presentation time in isolated Next children, never the database/API. */
export function goldenClockArgs(directory: string): string[] {
  const root = fs.realpathSync(directory);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("growdesk-integration-"));
  const preload = path.join(root, "golden-clock.mjs");
  const source = `const OriginalDate = globalThis.Date;
const now = OriginalDate.parse(${JSON.stringify(GOLDEN_NOW)});
function FixedDate(...args) {
  if (!new.target) return new OriginalDate(now).toString();
  return Reflect.construct(OriginalDate, args.length ? args : [now], new.target);
}
Object.setPrototypeOf(FixedDate, OriginalDate);
FixedDate.prototype = OriginalDate.prototype;
FixedDate.now = () => now;
// Next wraps Date and copies its own static members. Inherited parse/UTC
// disappear through that wrapper, so preserve the native own-property shape.
FixedDate.parse = OriginalDate.parse;
FixedDate.UTC = OriginalDate.UTC;
globalThis.Date = FixedDate;
`;
  if (fs.existsSync(preload)) assert.equal(fs.readFileSync(preload, "utf8"), source);
  else fs.writeFileSync(preload, source, { mode: 0o600, flag: "wx" });
  return ["--import", preload];
}
