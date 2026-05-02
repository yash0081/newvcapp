import test from "node:test";
import assert from "node:assert/strict";
import {
  isHighQualityLiveQuestion,
  isInvestableQuestionSeed,
} from "@/lib/live-assistant/similar-deal-questions";

test("question seed filter drops person-only claims", () => {
  assert.equal(
    isInvestableQuestionSeed({
      text: "John Smith joined as an advisor and has been helping the company think through strategy.",
      section: "team",
    }),
    false,
  );
});

test("question quality filter rejects forced role questions on person mentions", () => {
  const claim = {
    text: "John Smith joined as an advisor and has been helping the company think through strategy.",
    section: "team",
  };

  assert.equal(isHighQualityLiveQuestion("What is John's role in GTM and product strategy?", claim), false);
});

test("question quality filter keeps concrete diligence questions", () => {
  const claim = {
    text: "Enterprise customers are expanding from pilot deployments into annual contracts with $120K ACV.",
    section: "traction",
  };

  assert.equal(
    isHighQualityLiveQuestion("How many pilot deployments have converted into annual contracts at the $120K ACV level?", claim),
    true,
  );
});
