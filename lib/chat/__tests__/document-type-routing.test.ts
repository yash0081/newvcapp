import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyDocumentDelivery,
  findTypeMentionedInMessage,
  messageRequestsSavedDocumentGeneration,
  pickSavedDocumentType,
  resolveDocumentGeneration,
  type DocumentTypeSummary,
} from "@/lib/chat/document-type-routing";

function type(id: string, name: string, extra: Partial<DocumentTypeSummary> = {}): DocumentTypeSummary {
  return {
    id,
    name,
    output_format: extra.output_format ?? "pdf",
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

  test("pickSavedDocumentType uses exact saved name Report", () => {
    const pick = pickSavedDocumentType("Draft a report for Acme", [type("r1", "Report")]);
    assert.equal(pick.kind, "ready");
    if (pick.kind === "ready") assert.equal(pick.type.id, "r1");
  });

  test("pickSavedDocumentType does not map generic report to unrelated IC Memo", () => {
    const pick = pickSavedDocumentType("Make a report for Acme", [type("ic1", "IC Memo")]);
    assert.equal(pick.kind, "clarify");
  });

  test("pickSavedDocumentType uses only saved type when user has one", () => {
    const pick = pickSavedDocumentType("Generate a document for Acme", [type("r1", "Report")]);
    assert.equal(pick.kind, "ready");
    if (pick.kind === "ready") assert.equal(pick.type.name, "Report");
  });

  test("pickSavedDocumentType clarifies when multiple saved types and no name in message", () => {
    const pick = pickSavedDocumentType("Generate a document for Acme", [
      type("r1", "Report"),
      type("b1", "Brief"),
    ]);
    assert.equal(pick.kind, "clarify");
    if (pick.kind === "clarify") assert.equal(pick.types.length, 2);
  });

  test("resolveDocumentGeneration ready when Report is named", () => {
    const resolution = resolveDocumentGeneration({
      message: "Draft a Report for Acme",
      types: [type("r1", "Report"), type("b1", "Brief")],
      generateEnabled: true,
    });
    assert.equal(resolution.status, "ready");
    if (resolution.status === "ready") assert.equal(resolution.type.id, "r1");
  });

  test("resolveDocumentGeneration clarify_type when generic report and wrong types", () => {
    const resolution = resolveDocumentGeneration({
      message: "Make a report for Acme",
      types: [type("ic1", "IC Memo")],
      generateEnabled: true,
    });
    assert.equal(resolution.status, "clarify_type");
  });

  test("ambiguous summary request clarifies delivery", () => {
    const resolution = resolveDocumentGeneration({
      message: "Give me a summary of Acme",
      types: [type("r1", "Report")],
    });
    assert.equal(resolution.status, "clarify_delivery");
  });

  test("explicit request with no types needs setup", () => {
    const resolution = resolveDocumentGeneration({
      message: "Make a report for Acme",
      types: [],
      generateEnabled: true,
    });
    assert.equal(resolution.status, "needs_setup");
  });

  test("general question skips document resolution", () => {
    const resolution = resolveDocumentGeneration({
      message: "What is their TAM?",
      types: [type("r1", "Report")],
    });
    assert.equal(resolution.status, "skip");
  });

  test("messageRequestsSavedDocumentGeneration detects generate verbs", () => {
    assert.equal(messageRequestsSavedDocumentGeneration("Draft a report for Acme"), true);
    assert.equal(messageRequestsSavedDocumentGeneration("What is their TAM?"), false);
  });

  test("findTypeMentionedInMessage matches saved Report type", () => {
    const match = findTypeMentionedInMessage("Please use the Report doc type for Acme", [
      type("r1", "Report"),
      type("m1", "IC Memo"),
    ]);
    assert.equal(match?.id, "r1");
  });

  test("router typeId ignored unless message names that type", () => {
    const resolution = resolveDocumentGeneration({
      message: "Draft something for Acme",
      types: [type("r1", "Report"), type("b1", "Brief")],
      typeIdFromRouter: "b1",
      generateEnabled: true,
    });
    assert.equal(resolution.status, "clarify_type");
  });
});
