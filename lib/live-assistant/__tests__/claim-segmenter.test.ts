import test from "node:test";
import assert from "node:assert/strict";
import { splitClaimTextOnConjunctions } from "@/lib/live-assistant/claim-segmenter";

test("splitClaimTextOnConjunctions splits long and/but clauses", () => {
  const parts = splitClaimTextOnConjunctions(
    "We sell to mid-market enterprises and our average contract is six figures but churn is still high",
    20,
  );
  assert.ok(parts.length >= 2);
});

test("splitClaimTextOnConjunctions leaves short text intact", () => {
  const parts = splitClaimTextOnConjunctions("We are pre-revenue.", 20);
  assert.equal(parts.length, 1);
});
