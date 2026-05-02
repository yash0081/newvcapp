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

test("same segmentId replaces in buffer (smart-format rewrite), one chunk on EOS", () => {
  const builder = new SemanticChunkBuilder({ pauseMs: 999_999, minTokens: 10, maxTokens: 80 });
  builder.ingest(
    {
      segmentId: "g:0:1000",
      speaker: "guest:1",
      text: "Our annual revenue is one hundred",
      tStartMs: 0,
      tEndMs: 100,
      isFinal: true,
    },
    "final",
  );
  builder.ingest(
    {
      segmentId: "g:0:1000",
      speaker: "guest:1",
      text: "Our annual revenue is 100,000,000,000",
      tStartMs: 0,
      tEndMs: 100,
      isFinal: true,
    },
    "final",
  );
  const eosOut = builder.ingest(
    {
      segmentId: "g:0:1000",
      speaker: "guest:1",
      text: "Our annual revenue is 100,000,000,000",
      tStartMs: 0,
      tEndMs: 100,
      isFinal: true,
    },
    "eos",
  );
  assert.equal(eosOut.length, 1);
  assert.ok(/100,000,000,000/.test(eosOut[0]!.text));
  assert.ok(!/one hundred/i.test(eosOut[0]!.text));
});

test("distinct segmentIds accumulate until EOS", () => {
  const builder = new SemanticChunkBuilder({ pauseMs: 999_999, minTokens: 8, maxTokens: 80 });
  builder.ingest(
    { segmentId: "a", speaker: "guest:1", text: "100", tStartMs: 0, tEndMs: 40, isFinal: true },
    "final",
  );
  builder.ingest(
    { segmentId: "b", speaker: "guest:1", text: "1000", tStartMs: 50, tEndMs: 90, isFinal: true },
    "final",
  );
  const out = builder.ingest({ segmentId: "b", speaker: "guest:1", text: "1000", tStartMs: 50, tEndMs: 90, isFinal: true }, "eos");
  assert.equal(out.length, 1);
  assert.ok(/\b100\b/.test(out[0]!.text) && /\b1000\b/.test(out[0]!.text));
});

test("short question flushes on punctuation even below minTokens", () => {
  const builder = new SemanticChunkBuilder({ pauseMs: 999_999, minTokens: 20, maxTokens: 80 });
  const out = builder.ingest(
    {
      segmentId: "q",
      speaker: "host:1",
      text: "What is the revenue of your company?",
      tStartMs: 0,
      tEndMs: 200,
      isFinal: false,
    },
    "final",
  );
  assert.equal(out.length, 1);
  assert.ok(/revenue/.test(out[0]!.text));
  assert.ok(out[0]!.text.includes("?"));
});

test("flushIdle emits after silence when above minTokens", () => {
  const builder = new SemanticChunkBuilder({ pauseMs: 500, minTokens: 4, maxTokens: 80 });
  builder.ingest(
    {
      segmentId: "s1",
      speaker: "guest:1",
      text: "foo bar baz enough tokens here for sure",
      tStartMs: 0,
      tEndMs: 100,
      isFinal: true,
    },
    "final",
  );
  const idle = builder.flushIdle(10_000);
  assert.equal(idle.length, 1);
});

test("short utterance flushes on EOS without minTokens gate", () => {
  const builder = new SemanticChunkBuilder({ pauseMs: 999_999, minTokens: 20, maxTokens: 80 });
  builder.ingest(
    { segmentId: "x", speaker: "guest:1", text: "Yes we did", tStartMs: 0, tEndMs: 100, isFinal: true },
    "final",
  );
  const out = builder.ingest(
    { segmentId: "x", speaker: "guest:1", text: "Yes we did", tStartMs: 0, tEndMs: 100, isFinal: true },
    "eos",
  );
  assert.equal(out.length, 1);
  assert.ok(out[0]!.tokenCount >= 3);
});
