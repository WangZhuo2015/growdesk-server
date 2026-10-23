import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { PresentPassportCardEventSchema } from "../src/passport.js";

const validCardEvent = {
  v: 1,
  type: "card.present",
  turnId: "turn-1727880000000-17",
  runId: "00000000-0000-4000-8000-000000000001",
  card: {
    schemaVersion: 1,
    kind: "record_proposal",
    entityType: "feeding",
    title: "记录喂奶",
    status: "awaiting_confirmation",
    fields: [{ label: "奶量", value: "140", unit: "mL" }],
  },
  confirmation: {
    planHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    actionIds: ["00000000-0000-4000-8000-000000000002"],
    expiresAt: "2026-10-02T12:00:00.000Z",
  },
};

test("Passport card event accepts bounded per-turn correlation and legacy omission", () => {
  assert.equal(Value.Check(PresentPassportCardEventSchema, validCardEvent), true);
  assert.equal(
    Value.Check(PresentPassportCardEventSchema, { ...validCardEvent, turnId: "t".repeat(63) }),
    true,
  );

  // Keep the schema additive for rollout, while gateways are expected to emit turnId.
  const legacyEvent = { ...validCardEvent };
  Reflect.deleteProperty(legacyEvent, "turnId");
  assert.equal(Value.Check(PresentPassportCardEventSchema, legacyEvent), true);

  for (const turnId of ["", "t".repeat(64)]) {
    assert.equal(Value.Check(PresentPassportCardEventSchema, { ...validCardEvent, turnId }), false);
  }

  assert.equal(
    Value.Check(PresentPassportCardEventSchema, {
      ...validCardEvent,
      confirmation: {
        ...validCardEvent.confirmation,
        actionIds: [
          ...validCardEvent.confirmation.actionIds,
          "00000000-0000-4000-8000-000000000003",
        ],
      },
    }),
    false,
  );
});
