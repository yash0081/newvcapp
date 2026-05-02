import test from "node:test";
import assert from "node:assert/strict";
import {
  guestTurnActuallyAnswersQuestion,
  normalizeAnswerResolution,
} from "@/lib/live-assistant/guest-turn-verify";

test("answer guard rejects related but non-answering leadership comments", () => {
  assert.equal(
    guestTurnActuallyAnswersQuestion(
      "Could you clarify the current leadership team, as my records indicate Jensen Huang as a primary founder?",
      "His name is Daniel, he's a pretty chill guy.",
    ),
    true,
  );

  assert.equal(
    guestTurnActuallyAnswersQuestion(
      "Could you clarify the current leadership team, as my records indicate Jensen Huang as a primary founder?",
      "He is a chill guy.",
    ),
    false,
  );
});

test("answer guard accepts direct reconciliation answers", () => {
  assert.equal(
    guestTurnActuallyAnswersQuestion(
      "Could you clarify the current leadership team, as my records indicate Jensen Huang as a primary founder?",
      "Jensen is no longer CEO; Daniel became CEO in March and Jensen is now an advisor.",
    ),
    true,
  );
});

test("answer resolution normalizer treats related-but-unresolved as not answered", () => {
  assert.deepEqual(
    normalizeAnswerResolution({
      status: "not_answered",
      confidence: 0.91,
      rationale: "The guest gave a related opinion but did not clarify the leadership facts.",
      answer_excerpt: null,
    }),
    {
      status: "not_answered",
      confidence: 0.91,
      rationale: "The guest gave a related opinion but did not clarify the leadership facts.",
      answerExcerpt: null,
    },
  );
});

test("answer resolution normalizer preserves partial as non-terminal", () => {
  const result = normalizeAnswerResolution({
    status: "partial",
    confidence: 0.86,
    rationale: "The guest named one person but did not reconcile the record.",
    answer_excerpt: "Daniel is involved.",
  });

  assert.equal(result.status, "partial");
  assert.equal(result.confidence, 0.86);
  assert.equal(result.answerExcerpt, "Daniel is involved.");
});
