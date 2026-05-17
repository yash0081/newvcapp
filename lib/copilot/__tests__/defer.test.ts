import assert from "node:assert/strict";
import test from "node:test";
import { deferLeavingPage } from "@/lib/copilot/plan-next";
import { emptyAgenda } from "@/lib/copilot/research-agenda";

test("deferLeavingPage returns null when no signals", () => {
  const result = deferLeavingPage(undefined, "https://example.com", emptyAgenda({
    company: { name: "Test" },
    focus: "",
    preferencesSummary: "",
    openGaps: [],
  }));
  assert.equal(result, null);
});

test("deferLeavingPage scrolls when scroll depth is low in deep research", () => {
  const agenda = emptyAgenda({
    company: { name: "Test" },
    focus: "",
    preferencesSummary: "",
    openGaps: [],
  });
  agenda.is_deep_research = true;
  agenda.depth_profile = {
    avg_scroll_depth: 0.7,
    avg_drafts_per_page: 2,
    avg_viewed_sections: 3,
    avg_section_dwell_ms: 15000,
    avg_visits_per_host: 2,
    focused_headings: [],
    sample_count: 5,
  };
  
  const signals = {
    scrollDepthRatio: 0.5,
    draftItemsOnUrl: 0,
    pendingSuggestionsCount: 0,
    consecutivePlanScrolls: 0,
    visibleTextChars: 1000,
    viewedSectionCount: 1,
    sectionDwellMs: 5000,
    skimSectionCount: 5,
    skimVisibleSectionCount: 3,
    skimRelevantSectionCount: 2,
  };
  
  const result = deferLeavingPage(signals, "https://example.com", agenda);
  assert.equal(result, "scroll");
});

test("deferLeavingPage waits when pending suggestions exist in deep research", () => {
  const agenda = emptyAgenda({
    company: { name: "Test" },
    focus: "",
    preferencesSummary: "",
    openGaps: [],
  });
  agenda.is_deep_research = true;
  agenda.depth_profile = {
    avg_scroll_depth: 0.95,
    avg_drafts_per_page: 5,
    avg_viewed_sections: 3,
    avg_section_dwell_ms: 15000,
    avg_visits_per_host: 2,
    focused_headings: [],
    sample_count: 5,
  };
  
  const signals = {
    scrollDepthRatio: 0.99,
    draftItemsOnUrl: 5,
    pendingSuggestionsCount: 2,
    consecutivePlanScrolls: 5,
    visibleTextChars: 5000,
    viewedSectionCount: 5,
    sectionDwellMs: 20000,
    skimSectionCount: 10,
    skimVisibleSectionCount: 8,
    skimRelevantSectionCount: 5,
  };
  
  const result = deferLeavingPage(signals, "https://example.com", agenda);
  assert.equal(result, "wait");
});

test("deferLeavingPage allows navigation when depth is met", () => {
  const agenda = emptyAgenda({
    company: { name: "Test" },
    focus: "",
    preferencesSummary: "",
    openGaps: [],
  });
  agenda.depth_profile = {
    avg_scroll_depth: 0.6,
    avg_drafts_per_page: 2,
    avg_viewed_sections: 3,
    avg_section_dwell_ms: 15000,
    avg_visits_per_host: 2,
    focused_headings: [],
    sample_count: 5,
  };
  
  const signals = {
    scrollDepthRatio: 0.8,
    draftItemsOnUrl: 3,
    pendingSuggestionsCount: 0,
    consecutivePlanScrolls: 5,
    visibleTextChars: 3000,
    viewedSectionCount: 4,
    sectionDwellMs: 12000,
    skimSectionCount: 6,
    skimVisibleSectionCount: 4,
    skimRelevantSectionCount: 3,
  };
  
  const result = deferLeavingPage(signals, "https://example.com", agenda);
  assert.equal(result, null);
});

test("deferLeavingPage uses learned depth profile thresholds", () => {
  const agenda = emptyAgenda({
    company: { name: "Test" },
    focus: "",
    preferencesSummary: "",
    openGaps: [],
  });
  // User tends to scroll deeper
  agenda.depth_profile = {
    avg_scroll_depth: 0.9,
    avg_drafts_per_page: 4,
    avg_viewed_sections: 5,
    avg_section_dwell_ms: 20000,
    avg_visits_per_host: 2,
    focused_headings: [],
    sample_count: 10,
  };
  
  const signals = {
    scrollDepthRatio: 0.85,
    draftItemsOnUrl: 3,
    pendingSuggestionsCount: 0,
    consecutivePlanScrolls: 2,
    visibleTextChars: 4000,
    viewedSectionCount: 4,
    sectionDwellMs: 15000,
    skimSectionCount: 8,
    skimVisibleSectionCount: 5,
    skimRelevantSectionCount: 4,
  };
  
  const result = deferLeavingPage(signals, "https://example.com", agenda);
  // Should scroll because user's learned depth is higher than current
  assert.equal(result, "scroll");
});
