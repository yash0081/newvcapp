import type { SimilarPeerBundleForPipeline, SimilarPeerForPrompt } from "@/lib/similar-deals/types";

function formatPeerDigestLine(p: SimilarPeerForPrompt, rank: number): string {
  const pb = [p.problem_one_liner, p.solution_one_liner].filter(Boolean).join(" | ");
  const inv = p.investors.length ? `investors: ${p.investors.slice(0, 12).join(", ")}` : "";
  const sim = Number.isFinite(p.similarity_confidence)
    ? `sim:${Math.round(p.similarity_confidence * 100)}%`
    : "";
  return `${rank}. ${p.company_name} — ${pb || "(no one-liners)"}${inv ? ` — ${inv}` : ""}${
    sim ? ` — ${sim}` : ""
  }`;
}

function buildCorpusPeersDigest(
  bundle: SimilarPeerBundleForPipeline,
  section: "thesis" | "traction" | "problem" | "solution" | "assumptions"
): string {
  const lines: string[] = [
    "PORTFOLIO COMPARABLES — read this block first. Deck JSON below is authoritative; peers are for pattern context only.",
    "",
    "OVERALL (fused similarity, top 3):",
  ];
  bundle.overall.forEach((p, i) => lines.push(formatPeerDigestLine(p, i + 1)));
  const secPeers =
    section === "thesis" || section === "traction"
      ? bundle.market_focused
      : section === "problem"
        ? bundle.problem_focused
        : section === "solution"
          ? bundle.solution_focused
          : bundle.risk_focused;
  const secTitle =
    section === "thesis" || section === "traction"
      ? "MARKET-FOCUSED (top 3)"
      : section === "problem"
        ? "PROBLEM-FOCUSED (top 3)"
        : section === "solution"
          ? "SOLUTION-FOCUSED (top 3)"
          : "RISK-FOCUSED (top 3)";
  if (secPeers.length > 0) {
    lines.push("", `${secTitle} (mirrors the second peer JSON array when present):`);
    secPeers.forEach((p, i) => lines.push(formatPeerDigestLine(p, i + 1)));
  }
  return lines.join("\n");
}

/** Digest (plain text) + JSON arrays for `runWithTextMulti`. Digest is listed first so the model sees peers before long deck JSON. */
export function labeledSimilarCompanyInputs(
  bundle: SimilarPeerBundleForPipeline | null,
  section: "thesis" | "traction" | "problem" | "solution" | "assumptions"
): { label: string; value: unknown }[] {
  if (!bundle || bundle.overall.length === 0) return [];
  const digest = buildCorpusPeersDigest(bundle, section);
  const out: { label: string; value: unknown }[] = [
    { label: "corpus_peers_digest", value: digest },
    { label: "similar_companies_overall_top", value: bundle.overall },
  ];
  switch (section) {
    case "thesis":
    case "traction":
      if (bundle.market_focused.length > 0) {
        out.push({ label: "similar_companies_market_focused", value: bundle.market_focused });
      }
      break;
    case "problem":
      if (bundle.problem_focused.length > 0) {
        out.push({ label: "similar_companies_problem_focused", value: bundle.problem_focused });
      }
      break;
    case "solution":
      if (bundle.solution_focused.length > 0) {
        out.push({ label: "similar_companies_solution_focused", value: bundle.solution_focused });
      }
      break;
    case "assumptions":
      if (bundle.risk_focused.length > 0) {
        out.push({ label: "similar_companies_risk_focused", value: bundle.risk_focused });
      }
      break;
  }
  return out;
}
