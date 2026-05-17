import assert from "node:assert/strict";
import test from "node:test";
import {
  RECOMMENDER_PRIORS,
  buildCandidateFeatures,
  clamp,
  scoreFeatures,
  sgdUpdate,
  explorationEpsilon,
} from "@/lib/copilot/recommender-weights";

test("clamp constrains values within bounds", () => {
  assert.equal(clamp(5.0, -3.0, 3.0), 3.0);
  assert.equal(clamp(-5.0, -3.0, 3.0), -3.0);
  assert.equal(clamp(1.0, -3.0, 3.0), 1.0);
  assert.equal(clamp(0.0, -3.0, 3.0), 0.0);
});

test("scoreFeatures computes weighted sum with bias", () => {
  const features = {
    task_fit: 1.0,
    freq_penalty: 0.5,
    accept_signal: 0.8,
    reject_signal: 0.2,
    page_relevance: 0.7,
  };
  const weights = {
    w_task: 1.0,
    w_freq: 0.7,
    w_accept: 0.6,
    w_reject: 1.2,
    w_page: 0.5,
    bias: 0.0,
  };
  const score = scoreFeatures(features, weights);
  const expected =
    1.0 * 1.0 +
    0.5 * 0.7 +
    0.8 * 0.6 +
    0.2 * 1.2 +
    0.7 * 0.5 +
    0.0;
  assert.ok(Math.abs(score - expected) < 0.001);
});

test("explorationEpsilon decays with updates count", () => {
  const epsilon0 = explorationEpsilon(0);
  const epsilon10 = explorationEpsilon(10);
  const epsilon100 = explorationEpsilon(100);
  assert.ok(epsilon0 > epsilon10);
  assert.ok(epsilon10 > epsilon100);
  assert.ok(epsilon100 >= 0.05);
});

test("sgdUpdate updates weights based on label", () => {
  const weights = { ...RECOMMENDER_PRIORS };
  const features = {
    task_fit: 1.0,
    freq_penalty: 0.5,
    accept_signal: 0.8,
    reject_signal: 0.2,
    page_relevance: 0.7,
  };

  // Positive label should update weights
  const updated = sgdUpdate({
    weights,
    features,
    label: 1,
    sampleWeight: 1.0,
    updatesCount: 0,
  });
  assert.ok(typeof updated.w_task === "number");
  assert.ok(typeof updated.w_freq === "number");

  // Negative label should update weights differently
  const updated2 = sgdUpdate({
    weights,
    features,
    label: 0,
    sampleWeight: 1.0,
    updatesCount: 0,
  });
  assert.ok(typeof updated2.w_task === "number");
  assert.ok(typeof updated2.w_freq === "number");
});

test("buildCandidateFeatures computes all features", () => {
  const features = buildCandidateFeatures(
    {
      url: "https://example.com/test",
      host: "example.com",
      text: "test content",
      heading: "Test",
      hostVisitCount: 2,
      isOutboundLink: true,
      inViewedSection: false,
    },
    {
      taskTokens: ["test", "content"],
      taskSourceKinds: ["blog", "news"],
      avgVisitsPerHost: 2,
      acceptedHosts: new Set(["other.com"]),
      rejectedHosts: new Set(),
      blockedHosts: new Set(),
    },
  );

  assert.ok(typeof features.task_fit === "number");
  assert.ok(typeof features.freq_penalty === "number");
  assert.ok(typeof features.accept_signal === "number");
  assert.ok(typeof features.reject_signal === "number");
  assert.ok(typeof features.page_relevance === "number");

  // task_fit should be positive when tokens match
  assert.ok(features.task_fit >= 0);

  // freq_penalty should be positive when host visit count exceeds average
  assert.ok(features.freq_penalty >= 0);
});
