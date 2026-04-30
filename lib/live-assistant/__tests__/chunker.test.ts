import test from "node:test";
import assert from "node:assert/strict";
import { SemanticChunkBuilder } from "@/lib/live-assistant/chunker";

test("semantic chunker finalizes on pause threshold", () => {
  const builder = new SemanticChunkBuilder({ pauseMs: 1200, minTokens: 4, maxTokens: 40 });
  const a = builder.ingest(
    {
      segmentId: "s1",
      speaker: "guest:1",
      text: "We have strong growth and low churn.",
      tStartMs: 0,
      tEndMs: 1000,
      isFinal: false,
    },
    "interim",
  );
  assert.equal(a.length, 0);
  const b = builder.ingest(
    {
      segmentId: "s2",
      speaker: "guest:1",
      text: "Revenue reached five million ARR.",
      tStartMs: 2500,
      tEndMs: 3200,
      isFinal: true,
    },
    "final",
  );
  assert.ok(b.length >= 1);
});

