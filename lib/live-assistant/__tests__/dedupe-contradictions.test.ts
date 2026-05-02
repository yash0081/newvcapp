import assert from "node:assert/strict";
import test from "node:test";
import { contradictionBodiesNearDuplicate } from "@/lib/live-assistant/dedupe-contradictions";

test("near-duplicate when only the tail word differs (same story)", () => {
  const a =
    "Guest quote eleven million ARR versus CRM nine million annual recurring revenue highlight";
  const b =
    "Guest quote eleven million ARR versus CRM nine million annual recurring revenue summary";
  assert.equal(contradictionBodiesNearDuplicate(a, b), true);
});

test("not duplicate for different conflicts", () => {
  const a = "Guest: We have two hundred enterprise customers.\nOur records: fifty logos.";
  const b = "Guest: ARR is twelve million.\nCRM snapshot: eight million annual recurring revenue.";
  assert.equal(contradictionBodiesNearDuplicate(a, b), false);
});
