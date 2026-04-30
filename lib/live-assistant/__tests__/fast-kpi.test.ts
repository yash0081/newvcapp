import test from "node:test";
import assert from "node:assert/strict";
import { extractFastSignals } from "@/lib/live-assistant/fast-kpi";

test("extractFastSignals normalizes ARR and growth", () => {
  const s = extractFastSignals("We are at $5M ARR and growing 20% MoM with 1200 customers.");
  assert.ok(s.metrics.length >= 2);
  const arr = s.metrics.find((m) => m.key === "arr");
  assert.ok(arr);
  assert.equal(arr?.normalizedValue, 5_000_000);
  const growth = s.metrics.find((m) => m.key === "growth");
  assert.equal(growth?.normalizedValue, 0.2);
});

