import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  enrichMatrixCreateFromMessage,
  extractMatrixColumnHints,
  extractMatrixCreateCompanyHints,
  matchDealsFromHints,
  messageRequestsMatrixCreate,
  scoreNameMatch,
} from "@/lib/diligence-matrix/matrix-chat-intent";

describe("messageRequestsMatrixCreate", () => {
  test("detects make-a-matrix phrasing", () => {
    assert.equal(
      messageRequestsMatrixCreate(
        "make a matrix being fibr ai and alpen labs with TAM and SAM and maybe 1-2 other columns",
      ),
      true,
    );
  });
});

describe("extractMatrixCreateCompanyHints", () => {
  test("parses companies after matrix being", () => {
    const hints = extractMatrixCreateCompanyHints(
      "make a matrix being fibr ai and alpen labs with TAM and SAM",
    );
    assert.deepEqual(hints, ["fibr ai", "alpen labs"]);
  });
});

describe("matchDealsFromHints", () => {
  test("fuzzy-matches pipeline company names", () => {
    const deals = [
      { id: "d1", name: "Fibr AI" },
      { id: "d2", name: "Alpen Labs" },
    ];
    const matched = matchDealsFromHints(deals, ["fibr ai", "alpen labs"]);
    assert.equal(matched.length, 2);
    assert.equal(matched[0]?.id, "d1");
    assert.equal(matched[1]?.id, "d2");
  });
});

describe("extractMatrixColumnHints", () => {
  test("pulls TAM SAM and column theme", () => {
    const { explicitColumns, columnTheme } = extractMatrixColumnHints(
      "with TAM and SAM and maybe 1-2 other columns that fit this sort of idea",
    );
    assert.ok(explicitColumns.some((col) => col.label === "TAM"));
    assert.ok(explicitColumns.some((col) => col.label === "SAM"));
    assert.ok(columnTheme?.length);
  });
});

describe("enrichMatrixCreateFromMessage", () => {
  test("promotes create with matched deals and columns", () => {
    const allowed = new Set(["d1", "d2"]);
    const enriched = enrichMatrixCreateFromMessage(
      {
        action: "none",
        viewId: null,
        dealIds: [],
        name: null,
        columnTheme: null,
        explicitColumns: [],
        clarify: [],
        useMatrixIfRelevant: false,
      },
      "make a matrix being fibr ai and alpen labs with TAM and SAM and maybe 1-2 other columns",
      [
        { id: "d1", name: "Fibr AI" },
        { id: "d2", name: "Alpen Labs" },
      ],
      allowed,
      () => [],
    );
    assert.equal(enriched.action, "create");
    assert.deepEqual(enriched.dealIds, ["d1", "d2"]);
    assert.ok(enriched.explicitColumns.some((col: { label: string }) => col.label === "TAM"));
  });
});

describe("scoreNameMatch", () => {
  test("scores partial company names", () => {
    assert.ok(scoreNameMatch("Fibr AI", "fibr ai") >= 75);
  });
});
