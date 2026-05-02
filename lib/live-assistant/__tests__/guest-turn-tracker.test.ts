import test from "node:test";
import assert from "node:assert/strict";
import { GuestTurnTracker, type SettledTurn } from "@/lib/live-assistant/guest-turn-tracker";
import type { SemanticChunk } from "@/lib/live-assistant/chunker";

function chunk(opts: {
  id?: string;
  speaker: string;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
}): SemanticChunk {
  return {
    chunkId: opts.id ?? `${opts.speaker}:${opts.startedAtMs}:${opts.endedAtMs}`,
    speaker: opts.speaker,
    text: opts.text,
    tokenCount: opts.text.split(/\s+/).filter(Boolean).length,
    sentenceCount: 1,
    startedAtMs: opts.startedAtMs,
    endedAtMs: opts.endedAtMs,
    finalizeReason: "punctuation_boundary",
    sourceSegments: [],
    emittedAtMs: opts.endedAtMs,
  };
}

test("guest turn coalesces multiple chunks until host speaks", () => {
  const tracker = new GuestTurnTracker({ meetingId: "m1", settleMs: 5000 });
  const fired: SettledTurn[] = [];
  tracker.onGuestTurnSettled((t) => fired.push(t));

  tracker.ingestChunk(chunk({ speaker: "host:1", text: "What is the name of the CEO?", startedAtMs: 0, endedAtMs: 1000 }));
  tracker.ingestChunk(chunk({ speaker: "guest:1", text: "His", startedAtMs: 1500, endedAtMs: 1700 }));
  tracker.ingestChunk(chunk({ speaker: "guest:1", text: "name is Bob.", startedAtMs: 1700, endedAtMs: 2400 }));
  assert.equal(fired.length, 0, "guest should not have fired yet");

  tracker.ingestChunk(chunk({ speaker: "host:1", text: "Got it. Next question.", startedAtMs: 3000, endedAtMs: 3500 }));
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.role, "guest");
  assert.equal(fired[0]!.text, "His name is Bob.");
});

test("tickIdle settles open guest turn after silence", () => {
  const tracker = new GuestTurnTracker({ meetingId: "m1", settleMs: 1500 });
  const fired: SettledTurn[] = [];
  tracker.onGuestTurnSettled((t) => fired.push(t));

  tracker.ingestChunk(chunk({ speaker: "guest:1", text: "His name is Bob.", startedAtMs: 0, endedAtMs: 1000 }));
  tracker.tickIdle(1500);
  assert.equal(fired.length, 0, "still within settle window");
  tracker.tickIdle(5000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.text, "His name is Bob.");
});

test("host-only turns never fire the guest listener", () => {
  const tracker = new GuestTurnTracker({ meetingId: "m1", settleMs: 1000 });
  const fired: SettledTurn[] = [];
  tracker.onGuestTurnSettled((t) => fired.push(t));

  tracker.ingestChunk(chunk({ speaker: "host:1", text: "Hello.", startedAtMs: 0, endedAtMs: 500 }));
  tracker.ingestChunk(chunk({ speaker: "host:1", text: "Testing.", startedAtMs: 600, endedAtMs: 1100 }));
  tracker.tickIdle(5000);
  assert.equal(fired.length, 0);
});

test("getRecentDialogue includes settled turns plus in-progress open turn", () => {
  const tracker = new GuestTurnTracker({ meetingId: "m1", settleMs: 5000 });
  tracker.ingestChunk(chunk({ speaker: "host:1", text: "Hello.", startedAtMs: 0, endedAtMs: 500 }));
  tracker.ingestChunk(chunk({ speaker: "guest:1", text: "Hi.", startedAtMs: 700, endedAtMs: 1000 }));
  tracker.ingestChunk(chunk({ speaker: "host:1", text: "What is the name of the CEO?", startedAtMs: 1500, endedAtMs: 2500 }));
  tracker.ingestChunk(chunk({ speaker: "guest:1", text: "His name is Bob.", startedAtMs: 3000, endedAtMs: 3800 }));

  const lines = tracker.getRecentDialogue(4);
  assert.equal(lines.length, 4);
  assert.equal(lines[0]!.role, "host");
  assert.equal(lines[1]!.role, "guest");
  assert.equal(lines[2]!.role, "host");
  assert.equal(lines[3]!.role, "guest");
  assert.equal(lines[3]!.inProgress, true);
});

test("flushAll closes every open turn and emits guest turns", () => {
  const tracker = new GuestTurnTracker({ meetingId: "m1", settleMs: 999_999 });
  const fired: SettledTurn[] = [];
  tracker.onGuestTurnSettled((t) => fired.push(t));

  // Overlap so the host turn does not auto-settle on speaker switch.
  tracker.ingestChunk(chunk({ speaker: "host:1", text: "Hi.", startedAtMs: 0, endedAtMs: 1000 }));
  tracker.ingestChunk(chunk({ speaker: "guest:1", text: "Bob.", startedAtMs: 200, endedAtMs: 600 }));
  const out = tracker.flushAll();
  assert.equal(out.length, 2);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.text, "Bob.");
});
