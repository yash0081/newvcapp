import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildQuickLookupQuery,
  isDocumentGenerationRequest,
  isInternalOnlyQuestion,
} from "@/lib/research/fast-intent";

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
});
