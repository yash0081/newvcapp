import test from "node:test";
import assert from "node:assert/strict";
import {
  extractiveBulletsFromClaims,
  hybridTextFromClaimIds,
  narrowChunkContextForClaim,
  competitiveMemoLexiconGrounded,
  softGroundMemoBullet,
  validateAndRepairBullet,
  hasNovelProperNouns,
} from "@/lib/live-assistant/notes-grounding";

test("hasNovelProperNouns detects invented company", () => {
  const hay = "we compete with openai on apis";
  assert.equal(hasNovelProperNouns("Partners include Anduril.", hay), true);
  assert.equal(hasNovelProperNouns("OpenAI is a key integration.", hay), false);
});

test("validateAndRepairBullet drops invented proper noun", () => {
  const hay = "the product integrates with openai";
  const r = validateAndRepairBullet("Partners include OpenAI and Anduril.", hay);
  assert.ok(!r.text?.includes("Anduril"));
});

test("softGroundMemoBullet keeps memo phrasing when names are grounded", () => {
  const hay =
    "We're at about five million ARR this year; enterprise customers in fintech. Series B led by Acme Ventures.";
  const r = softGroundMemoBullet("About $5M ARR run-rate; enterprise-heavy; Series B with Acme Ventures.", hay);
  assert.ok(r.text && r.text.length >= 8);
});

test("softGroundMemoBullet drops invented proper nouns", () => {
  const hay = "we sell to mid-market retailers";
  assert.equal(softGroundMemoBullet("Key partner: Anduril for defense.", hay).text, null);
});

test("extractiveBulletsFromClaims returns claim slices only", () => {
  const out = extractiveBulletsFromClaims([
    { id: "a", text: "Revenue hit five million annually." },
    { id: "b", text: "Team is ten engineers." },
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.every((b) => b.claim_ids.length === 1));
});

test("hybridTextFromClaimIds stitches cited claims only", () => {
  const m = new Map([
    ["a", "Foo corp raised Series B."],
    ["b", "Hiring in SF."],
  ]);
  const t = hybridTextFromClaimIds(m, ["a", "b"]);
  assert.ok(t?.includes("Foo corp"));
  assert.ok(t?.includes("Hiring"));
});

test("narrowChunkContextForClaim keeps neighborhood of claim in chunk", () => {
  const chunk =
    "Host asked about hiring. Guest explained partner motion with Snowflake and AWS. Closing thoughts on roadmap.";
  const claim = "partner motion with Snowflake";
  const ex = narrowChunkContextForClaim(chunk, claim, 80);
  assert.ok(ex.includes("Snowflake"));
  assert.ok(ex.includes("partner motion"));
  assert.ok(ex.length <= chunk.length);
});

test("competitiveMemoLexiconGrounded rejects competition talk without source support", () => {
  assert.equal(competitiveMemoLexiconGrounded("Main competitors include Stripe.", "we partner with Stripe"), false);
  assert.equal(competitiveMemoLexiconGrounded("Partnership expansion with Stripe.", "we partner with Stripe"), true);
});

test("softGroundMemoBullet drops competitive framing when haystack lacks competitive lexicon", () => {
  const hay = "We signed channel partners including several ISVs.";
  assert.equal(softGroundMemoBullet("Competitive set includes Salesforce and Oracle.", hay).text, null);
});
