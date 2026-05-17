import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isValidPublicSourceUrl,
  sanitizeResearchNotes,
  sanitizeResearchSources,
} from "@/lib/research/public-output";

describe("public-output", () => {
  test("rejects internal-looking source titles", () => {
    const out = sanitizeResearchSources([
      {
        url: "https://www.crunchbase.com/organization/acme",
        title: "Task-level pruning kept only steps needed for the user goal.",
      },
    ]);
    assert.equal(out.length, 0);
  });

  test("keeps valid public sources", () => {
    const out = sanitizeResearchSources([
      {
        url: "https://techcrunch.com/2024/01/01/acme-funding",
        title: "Acme raises Series A",
        snippet: "Acme announced a $10M round led by Example VC.",
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.url, "https://techcrunch.com/2024/01/01/acme-funding");
  });

  test("rejects placeholder urls from prompts", () => {
    assert.equal(isValidPublicSourceUrl("https://..."), false);
    assert.equal(isValidPublicSourceUrl("https://example.com"), false);
  });

  test("strips echoed rules from notes", () => {
    const out = sanitizeResearchNotes(
      "Acme raised $10M in 2024.\n\nRULES:\n- Do not expand the research scope beyond the user's requested topics.",
    );
    assert.match(out, /Acme raised \$10M/);
    assert.doesNotMatch(out, /RULES:/);
    assert.doesNotMatch(out, /Do not expand the research scope/);
  });
});
