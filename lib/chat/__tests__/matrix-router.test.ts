import assert from "node:assert/strict";
import { describe, test } from "node:test";

/** Mirrors parseMatrixRouteFromRouter logic for fixture tests without loading full workspace-chat. */
function parseMatrixFixture(
  raw: Record<string, unknown>,
  allowedDealIds: Set<string>,
): {
  action: string;
  clarify: string[];
  dealIds: string[];
} {
  const actionRaw = typeof raw.action === "string" ? raw.action : "none";
  const action = actionRaw === "read" || actionRaw === "create" ? actionRaw : "none";
  const dealIds: string[] = [];
  if (Array.isArray(raw.dealIds)) {
    for (const id of raw.dealIds) {
      if (typeof id === "string" && allowedDealIds.has(id) && !dealIds.includes(id)) dealIds.push(id);
    }
  }
  const clarify: string[] = [];
  if (Array.isArray(raw.clarify)) {
    for (const c of raw.clarify) {
      if (c === "companies" || c === "columns" || c === "which_matrix") clarify.push(c);
    }
  }
  return {
    action: clarify.length && action === "create" ? "none" : action,
    clarify,
    dealIds,
  };
}

describe("matrix router fixtures", () => {
  const allowed = new Set(["deal-a", "deal-b"]);

  test("read action keeps companies without clarify", () => {
    const result = parseMatrixFixture(
      { action: "read", dealIds: ["deal-a", "deal-b"], clarify: [] },
      allowed,
    );
    assert.equal(result.action, "read");
    assert.deepEqual(result.dealIds, ["deal-a", "deal-b"]);
  });

  test("create with missing columns becomes none with clarify", () => {
    const result = parseMatrixFixture(
      { action: "create", dealIds: ["deal-a"], clarify: ["columns"] },
      allowed,
    );
    assert.equal(result.action, "none");
    assert.ok(result.clarify.includes("columns"));
  });

  test("create with full spec stays create", () => {
    const result = parseMatrixFixture(
      {
        action: "create",
        dealIds: ["deal-a", "deal-b"],
        columnTheme: "financial metrics",
        clarify: [],
      },
      allowed,
    );
    assert.equal(result.action, "create");
    assert.equal(result.dealIds.length, 2);
  });
});
