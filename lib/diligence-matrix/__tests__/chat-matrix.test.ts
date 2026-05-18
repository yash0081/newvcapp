import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildMatrixHref,
  buildMatrixSnapshotGrid,
  buildMatrixSnapshotPayload,
  buildMatrixToolBrief,
  enrichMatrixRoutePlan,
  extractArtifactSubjectHint,
  formatMatrixContextForPrompt,
  formatMatrixSnapshotMarkdown,
  formatMatrixViewsIndex,
  fuzzyMatchView,
  messageReferencesSavedMatrix,
  resolveMatrixViewFromMessage,
  type MatrixContextRow,
} from "@/lib/diligence-matrix/chat-matrix";

describe("buildMatrixHref", () => {
  test("uses company tabular route for single company", () => {
    const href = buildMatrixHref({
      viewId: "view-1",
      dealIds: ["deal-a"],
      singleDealId: "deal-a",
    });
    assert.equal(href, "/home/deal-intel/deal-a/tabular?view=view-1");
  });

  test("uses global matrix route for multiple companies", () => {
    const href = buildMatrixHref({
      viewId: "view-2",
      dealIds: ["deal-a", "deal-b"],
    });
    assert.equal(href, "/home/matrix?view=view-2");
  });
});

describe("formatMatrixContextForPrompt", () => {
  test("renders markdown table for filled rows", () => {
    const rows: MatrixContextRow[] = [
      {
        dealId: "d1",
        dealName: "Acme",
        columnId: "c1",
        columnLabel: "Revenue",
        valueText: "$10M ARR",
        status: "filled",
        sourceKind: "internal",
      },
    ];
    const text = formatMatrixContextForPrompt({
      viewId: "v1",
      viewName: "Test matrix",
      rows,
      filledCount: 1,
      emptyCount: 0,
      viewsIndex: [],
      companyOrder: [{ id: "d1", name: "Acme" }],
      columnOrder: [{ id: "c1", label: "Revenue" }],
    });
    assert.ok(text.includes("Test matrix"));
    assert.ok(text.includes("Acme"));
    assert.ok(text.includes("$10M ARR"));
    assert.ok(text.includes("Revenue=$10M ARR"));
  });

  test("reports when no data matched", () => {
    const text = formatMatrixContextForPrompt({
      viewId: null,
      viewName: null,
      rows: [],
      filledCount: 0,
      emptyCount: 0,
      viewsIndex: [],
      companyOrder: [],
      columnOrder: [],
    });
    assert.ok(text.includes("No saved matrix cell data"));
  });
});

describe("formatMatrixSnapshotMarkdown", () => {
  test("truncates long row lists", () => {
    const rows: MatrixContextRow[] = Array.from({ length: 20 }, (_, i) => ({
      dealId: `d${i}`,
      dealName: `Co ${i}`,
      columnId: "c1",
      columnLabel: "Stage",
      valueText: "Seed",
      status: "filled",
      sourceKind: "internal",
    }));
    const md = formatMatrixSnapshotMarkdown(rows, { maxRows: 5 });
    assert.ok(md.includes("and 15 more rows"));
  });
});

describe("matrix view resolution", () => {
  const views = [
    {
      id: "v-matrix-1",
      name: "Matrix 1",
      dealIds: ["deal-a"],
      columnIds: ["c1"],
      updatedAt: new Date().toISOString(),
    },
    {
      id: "v-saas",
      name: "SaaS comps",
      dealIds: ["deal-a", "deal-b"],
      columnIds: ["c1", "c2"],
      updatedAt: new Date().toISOString(),
    },
  ];

  test("extracts subject from tell-me-about phrasing", () => {
    assert.equal(extractArtifactSubjectHint("tell me about matrix 1"), "matrix 1");
  });

  test("fuzzy-matches saved matrix names", () => {
    assert.equal(fuzzyMatchView(views, "matrix 1")?.id, "v-matrix-1");
    assert.equal(resolveMatrixViewFromMessage("tell me about matrix 1", views)?.name, "Matrix 1");
    assert.equal(messageReferencesSavedMatrix("what is in Matrix 1?", views), true);
  });

  test("enrichMatrixRoutePlan promotes read when a saved matrix matches", () => {
    const allowed = new Set(["deal-a", "deal-b"]);
    const enriched = enrichMatrixRoutePlan(
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
      "tell me about matrix 1",
      views,
      allowed,
    );
    assert.equal(enriched.action, "read");
    assert.equal(enriched.viewId, "v-matrix-1");
    assert.deepEqual(enriched.dealIds, ["deal-a"]);
  });
});

describe("buildMatrixToolBrief", () => {
  test("returns authoritative brief for matrix read", () => {
    const brief = buildMatrixToolBrief({ action: "read", viewId: "v1", viewName: "Matrix 1" });
    assert.ok(brief?.includes("MATRIX TOOL"));
    assert.ok(brief?.includes("Matrix 1"));
    assert.ok(brief?.includes("Do NOT"));
  });
});

describe("buildMatrixSnapshotGrid", () => {
  test("lays out companies as rows and columns as headers", () => {
    const grid = buildMatrixSnapshotGrid(
      [
        {
          dealId: "d1",
          dealName: "Acme",
          columnId: "c1",
          columnLabel: "Revenue",
          valueText: "$10M",
          status: "filled",
          sourceKind: "internal",
        },
      ],
      { companyNames: ["Acme"], columnLabels: ["Revenue", "Stage"] },
    );
    assert.deepEqual(grid.companyNames, ["Acme"]);
    assert.deepEqual(grid.columnLabels, ["Revenue", "Stage"]);
    assert.equal(grid.values[0]?.[0], "$10M");
    assert.equal(grid.values[0]?.[1], null);
  });
});

describe("buildMatrixSnapshotPayload", () => {
  test("returns structured rows for UI", () => {
    const rows: MatrixContextRow[] = [
      {
        dealId: "d1",
        dealName: "Acme",
        columnId: "c1",
        columnLabel: "Revenue",
        valueText: "$10M",
        status: "filled",
        sourceKind: "internal",
      },
    ];
    const payload = buildMatrixSnapshotPayload(rows, { viewName: "Matrix 1" });
    assert.equal(payload.viewName, "Matrix 1");
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0]?.dealName, "Acme");
  });
});

describe("formatMatrixViewsIndex", () => {
  test("lists saved views for router prompt", () => {
    const index = formatMatrixViewsIndex([
      {
        id: "v1",
        name: "A vs B",
        dealIds: ["a", "b"],
        columnIds: ["c1", "c2"],
        updatedAt: new Date().toISOString(),
      },
    ]);
    assert.ok(index.includes("A vs B"));
    assert.ok(index.includes("id=v1"));
    assert.ok(index.includes("2 companies"));
  });
});
