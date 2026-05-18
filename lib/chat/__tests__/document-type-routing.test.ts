import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyDocumentDelivery,
  resolveDocumentGeneration,
  type DocumentTypeSummary,
} from "@/lib/chat/document-type-routing";

function type(id: string, name: string, extra: Partial<DocumentTypeSummary> = {}): DocumentTypeSummary {
  return {
    id,
    name,
    output_format: "text",
    description: extra.description ?? null,
    instructions: extra.instructions ?? null,
    learned_preferences: extra.learned_preferences ?? null,
    updated_at: null,
  };
}

describe("document-type-routing", () => {
  test("classifyDocumentDelivery distinguishes explicit vs ambiguous", () => {
    assert.equal(classifyDocumentDelivery("Draft a report for Acme"), "explicit");
    assert.equal(classifyDocumentDelivery("Give me a summary of Acme"), "ambiguous");
    assert.equal(classifyDocumentDelivery("What is their TAM?"), "none");
  });

  test("ready picks Report for explicit report request", () => {
    const resolution = resolveDocumentGeneration({
      message: "Draft a report for Acme",
      types: [type("r1", "Report")],
      typeHint: "report",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "ready");
    if (resolution.status === "ready") assert.equal(resolution.type.id, "r1");
  });

  test("ambiguous summary request clarifies delivery", () => {
    const resolution = resolveDocumentGeneration({
      message: "Give me a summary of Acme",
      types: [type("s1", "Summary")],
      typeHint: "summary",
    });
    assert.equal(resolution.status, "clarify_delivery");
  });

  test("explicit request with no types needs setup", () => {
    const resolution = resolveDocumentGeneration({
      message: "Make a report for Acme",
      types: [],
      typeHint: "report",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "needs_setup");
  });

  test("general question skips document resolution", () => {
    const resolution = resolveDocumentGeneration({
      message: "What is their TAM?",
      types: [type("r1", "Report")],
      typeHint: null,
    });
    assert.equal(resolution.status, "skip");
  });

  test("single saved type is used for explicit report request", () => {
    const resolution = resolveDocumentGeneration({
      message: "Make a report for Acme",
      types: [type("ic1", "IC Memo")],
      typeHint: "report",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "ready");
    if (resolution.status === "ready") assert.equal(resolution.type.name, "IC Memo");
  });

  test("weak single-type match clarifies type", () => {
    const resolution = resolveDocumentGeneration({
      message: "Draft an email for Acme",
      types: [type("ic1", "IC Memo")],
      typeHint: "email",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "clarify_type");
  });

  test("similar multi-type scores clarify which type", () => {
    const resolution = resolveDocumentGeneration({
      message: "Make a memo for Acme",
      types: [
        type("m1", "IC Memo", { description: "Investment committee memo template" }),
        type("m2", "Deal Memo", { description: "Deal screening memo template" }),
      ],
      typeHint: "memo",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "clarify_type");
  });

  test("router typeId wins when valid", () => {
    const resolution = resolveDocumentGeneration({
      message: "Draft something for Acme",
      types: [type("r1", "Report"), type("b1", "Brief")],
      typeHint: null,
      typeIdFromRouter: "b1",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "ready");
    if (resolution.status === "ready") assert.equal(resolution.type.id, "b1");
  });
});
