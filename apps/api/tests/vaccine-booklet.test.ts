import assert from "node:assert/strict";
import { test } from "node:test";
import { vaccineRecordDates } from "../src/services/vaccine-service.js";
import { CreateVaccineRecordRequestSchema, UpdateVaccineRecordRequestSchema } from "@growdesk/contracts";
import { Value } from "@sinclair/typebox/value";

test("historical vaccination never invents an appointment or today's date", () => {
  const result = vaccineRecordDates({ vaccineCode: "test_booklet", administeredDate: "2026-04-03" });
  assert.equal(result.administeredDate.toISOString(), "2026-04-03T00:00:00.000Z");
  assert.equal(result.completedDate?.toISOString(), "2026-04-03T00:00:00.000Z");
  assert.equal(result.scheduledDate, null);
});

test("incomplete and impossible calendar dates cannot become clinical facts", () => {
  for (const date of ["2026-04", "2026-02-29", "2026-02-30", "2026-13-01", "2026-04-03T00:00:00Z"]) {
    assert.throws(() => vaccineRecordDates({ vaccineCode: "test_booklet", administeredDate: date }));
  }
  assert.doesNotThrow(() => vaccineRecordDates({ vaccineCode: "test_booklet", administeredDate: "2024-02-29" }));
});

test("a plan remains pending and completion requires an explicit actual date", () => {
  const plan = vaccineRecordDates({ vaccineCode: "test_booklet", administeredDate: "2026-08-01", scheduledDate: "2026-08-01", isCompleted: false });
  assert.equal(plan.completedDate, null);
  const rescheduled = vaccineRecordDates({ baseVersion: "1", scheduledDate: "2026-08-03" }, plan);
  assert.equal(rescheduled.administeredDate.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(rescheduled.scheduledDate?.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(rescheduled.completedDate, null);
  assert.throws(() => vaccineRecordDates({ baseVersion: "1", isCompleted: true }, plan));
  const complete = vaccineRecordDates({ baseVersion: "1", isCompleted: true, administeredDate: "2026-08-05" }, plan);
  assert.equal(complete.completedDate?.toISOString(), "2026-08-05T00:00:00.000Z");
  assert.equal(complete.scheduledDate?.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.throws(() => vaccineRecordDates({ baseVersion: "1", scheduledDate: null }, plan));
  assert.throws(() => vaccineRecordDates({ baseVersion: "1", completedDate: "2026-08-01" }, plan));
  assert.throws(() => vaccineRecordDates({ vaccineCode: "test_booklet", administeredDate: "2026-08-01", completedDate: "2026-08-05" }));
});

test("booklet metadata is optional, unknown dose stays nullable, and patch requires a version", () => {
  const fields = CreateVaccineRecordRequestSchema.properties;
  assert.ok(Value.Check(fields.doseNumber, null));
  assert.ok(Value.Check(fields.traceabilityCode, "00001234567890"));
  assert.ok(Value.Check(fields.manufacturer, null));
  assert.equal(Value.Check(fields.doseNumber, 0), false);
  assert.equal(Value.Check(fields.traceabilityCode, 123456), false);
  assert.deepEqual(UpdateVaccineRecordRequestSchema.required, ["baseVersion"]);
  assert.equal(Value.Check(UpdateVaccineRecordRequestSchema, { notes: "test correction" }), false);
  assert.ok(Value.Check(UpdateVaccineRecordRequestSchema, { baseVersion: "1", clinic: null, doseNumber: null, traceabilityCode: "0001" }));
});
