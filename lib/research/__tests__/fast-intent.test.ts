import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildQuickLookupQuery,
  isDocumentGenerationRequest,
  isExplicitResearchRequest,
  isInternalOnlyQuestion,
  shouldUsePublicWebForChat,
} from "@/lib/research/fast-intent";
import { classifyResearchMode } from "@/lib/research/mode-router";

describe("fast-intent", () => {
  test("isInternalOnlyQuestion detects workspace-only asks", () => {
    assert.equal(isInternalOnlyQuestion("What did we save about their traction in our records?"), true);
    assert.equal(isInternalOnlyQuestion("Who is the current CEO?"), false);
    assert.equal(isInternalOnlyQuestion("What is the founder's technical background?"), false);
  });

  test("isDocumentGenerationRequest detects memo generation", () => {
    assert.equal(isDocumentGenerationRequest("Draft an IC memo for Acme"), true);
  });

  test("buildQuickLookupQuery adds company and verify hints", () => {
    const query = buildQuickLookupQuery({
      message: "latest funding round",
      companyName: "Acme Robotics",
      intent: {
        userGoal: "Verify latest funding round",
        requiredTopics: ["funding", "investors"],
        allowedCategories: ["traction"],
        excludedTopics: [],
        includeRiskCheck: false,
        mustCompare: false,
      },
    });
    assert.match(query, /Acme Robotics/i);
    assert.match(query, /funding/i);
  });

  test("ordinary commands do not trigger public web just because context is thin", () => {
    const message = "I am unhappy with my research on this company can you clear all the data";
    assert.equal(isExplicitResearchRequest(message), false);
    assert.equal(shouldUsePublicWebForChat(message), false);

    const decision = classifyResearchMode({
      message,
      deepModeEnabled: false,
      openGaps: [{ field: "traction.revenue_data", synonyms: ["revenue"] }],
      factChunkCount: 0,
      docChunkCount: 0,
    });
    assert.equal(decision.needsWeb, false);
    assert.equal(decision.needsWorkflow, false);
    assert.equal(decision.profile, "fast");
  });

  test("research noun mentions are distinct from research commands", () => {
    assert.equal(isExplicitResearchRequest("I am unhappy with my research on this company"), false);
    assert.equal(isExplicitResearchRequest("Research this company"), true);
    assert.equal(isExplicitResearchRequest("Can you look into the founder background?"), true);
  });

  test("thin internal context alone stays in saved-context chat path", () => {
    const decision = classifyResearchMode({
      message: "What do you think about this company?",
      deepModeEnabled: false,
      openGaps: [{ field: "traction.revenue_data", synonyms: ["revenue"] }],
      factChunkCount: 0,
      docChunkCount: 0,
    });
    assert.equal(decision.needsWeb, false);
    assert.equal(decision.needsWorkflow, false);
  });

  test("current public fact questions can still use fast web lookup", () => {
    assert.equal(shouldUsePublicWebForChat("Who is the CEO?"), false);
    assert.equal(shouldUsePublicWebForChat("Who is the current CEO?"), true);
    const decision = classifyResearchMode({
      message: "Who is the current CEO?",
      deepModeEnabled: false,
      openGaps: [],
      factChunkCount: 0,
      docChunkCount: 0,
    });
    assert.equal(decision.needsWeb, true);
    assert.equal(decision.needsWorkflow, false);
  });
});
