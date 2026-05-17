import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyResearchMode,
  internalContextSufficient,
  profileMaxSteps,
  quickLookupWeak,
  resolveResearchProfile,
  shouldUseLlmModeRouter,
} from "@/lib/research/mode-router";

test("classifyResearchMode requests web for current-public facts when deep mode is off", () => {
  const decision = classifyResearchMode({
    message: "What is Acme's latest funding round?",
    deepModeEnabled: false,
    openGaps: [],
    factChunkCount: 2,
    docChunkCount: 1,
  });
  assert.equal(decision.needsWeb, true);
  assert.equal(decision.profile, "fast");
});

test("classifyResearchMode can choose deep with toggle off for comprehensive diligence", () => {
  const decision = classifyResearchMode({
    message: "Run comprehensive deep research on everything for this company",
    deepModeEnabled: false,
    openGaps: Array.from({ length: 10 }, (_, i) => ({ field: `gap_${i}`, synonyms: [] })),
    factChunkCount: 0,
    docChunkCount: 0,
  });
  assert.equal(decision.profile, "deep");
  assert.equal(decision.needsWorkflow, true);
});

test("resolveResearchProfile does not downgrade deep when toggle is off", () => {
  assert.equal(resolveResearchProfile("deep", false, "compare competitors and funding history"), "deep");
});

test("resolveResearchProfile raises profile when deep toggle is on", () => {
  assert.equal(resolveResearchProfile("fast", true, "summarize"), "deep");
  assert.equal(resolveResearchProfile("standard", true, "who is the ceo"), "deep");
});

test("classifyResearchMode uses deep profile when deep mode is enabled", () => {
  const decision = classifyResearchMode({
    message: "Summarize what we know",
    deepModeEnabled: true,
    openGaps: [],
    factChunkCount: 5,
    docChunkCount: 3,
  });
  assert.equal(decision.profile, "deep");
  assert.equal(decision.needsWorkflow, true);
});

test("internalContextSufficient is false for thin context on public-fact questions", () => {
  assert.equal(
    internalContextSufficient({
      message: "Who is the current CEO?",
      openGaps: [],
      factChunkCount: 1,
      docChunkCount: 0,
    }),
    false,
  );
});

test("quickLookupWeak treats empty lookup as weak", () => {
  assert.equal(quickLookupWeak({ text: "", citations: [] }), true);
});

test("profileMaxSteps caps fast plans at 2 steps", () => {
  assert.equal(profileMaxSteps("fast"), 2);
});

test("shouldUseLlmModeRouter skips obvious single-fact lookups", () => {
  const decision = classifyResearchMode({
    message: "What is Acme's latest funding round?",
    deepModeEnabled: false,
    openGaps: [],
    factChunkCount: 2,
    docChunkCount: 1,
  });
  assert.equal(
    shouldUseLlmModeRouter({
      message: "What is Acme's latest funding round?",
      heuristic: decision,
      internalOk: false,
      openGapCount: 0,
    }),
    false,
  );
});

test("classifyResearchMode requests brief web even when saved context looks sufficient", () => {
  const decision = classifyResearchMode({
    message: "Summarize traction for this company",
    deepModeEnabled: false,
    openGaps: [{ field: "revenue", synonyms: [] }],
    factChunkCount: 5,
    docChunkCount: 4,
  });
  assert.equal(decision.profile, "fast");
  assert.equal(decision.needsWeb, true);
});

test("classifyResearchMode avoids deep workflow for document generation", () => {
  const decision = classifyResearchMode({
    message: "Generate an investment memo for this company",
    deepModeEnabled: true,
    openGaps: Array.from({ length: 10 }, (_, i) => ({ field: `gap_${i}`, synonyms: [] })),
    factChunkCount: 0,
    docChunkCount: 0,
    documentGenerationOnly: true,
  });
  assert.equal(decision.profile, "fast");
  assert.equal(decision.needsWorkflow, false);
});

test("classifyResearchMode requests web for founder background questions", () => {
  const decision = classifyResearchMode({
    message: "What is the founder's technical background?",
    deepModeEnabled: false,
    openGaps: [],
    factChunkCount: 5,
    docChunkCount: 4,
  });
  assert.equal(decision.needsWeb, true);
  assert.equal(decision.needsWorkflow, false);
});

test("classifyResearchMode skips web for workspace-only questions", () => {
  const decision = classifyResearchMode({
    message: "What did we save about their traction in our records?",
    deepModeEnabled: false,
    openGaps: [],
    factChunkCount: 5,
    docChunkCount: 4,
  });
  assert.equal(decision.needsWeb, false);
});

test("shouldUseLlmModeRouter triggers on standard heuristic profile", () => {
  assert.equal(
    shouldUseLlmModeRouter({
      message: "Research the competitor landscape for this company",
      heuristic: {
        profile: "standard",
        needsWeb: true,
        needsWorkflow: true,
        reason: "Explicit research workflow request.",
      },
      internalOk: false,
      openGapCount: 2,
    }),
    true,
  );
});
