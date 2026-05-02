/**
 * Investor-memo style bodies for live assistant cards (avoid transcript dialogue formatting).
 */

export function formatMemoClaimVerificationBody(args: {
  summary: string;
  recordsSnapshot?: string | null;
  relatedQuestion?: string | null;
  extraLines?: string[];
}): string {
  const lines: string[] = [];
  const rq = args.relatedQuestion?.trim();
  if (rq) lines.push(`Related diligence Q: ${rq.slice(0, 220)}`);
  lines.push(args.summary.trim().slice(0, 600));
  const rec = args.recordsSnapshot?.trim();
  if (rec) lines.push(`Records: ${rec.slice(0, 320)}`);
  for (const x of args.extraLines ?? []) {
    const t = String(x || "").trim();
    if (t) lines.push(t.slice(0, 320));
  }
  return lines.join("\n").trim().slice(0, 3500);
}

export function formatMemoContradictionBody(args: {
  headline: string;
  recordsSnapshot?: string | null;
  fieldPath?: string | null;
  whyItMatters?: string | null;
  followUps?: string[];
  /** When this clash relates to answering a tracked diligence question */
  relatedQuestion?: string | null;
}): string {
  const lines: string[] = [];
  const rq = args.relatedQuestion?.trim();
  if (rq) lines.push(`Related diligence Q: ${rq.slice(0, 220)}`);
  lines.push(args.headline.trim().slice(0, 500));
  const rec = args.recordsSnapshot?.trim();
  if (rec) lines.push(`Records: ${rec.slice(0, 320)}`);
  const fp = args.fieldPath?.trim();
  if (fp) lines.push(`Field: ${fp.slice(0, 140)}`);
  const why = args.whyItMatters?.trim();
  if (why) lines.push(`Note: ${why.slice(0, 280)}`);
  const fus = (args.followUps ?? []).map((f) => String(f).trim()).filter(Boolean).slice(0, 3);
  if (fus.length) {
    lines.push("");
    for (const f of fus) lines.push(`Follow-up: ${f.slice(0, 240)}`);
  }
  return lines.join("\n").trim().slice(0, 3500);
}

export function formatMemoKpiMiddleBody(args: {
  headline: string;
  founderInterpretation?: string | null;
  recordsSnapshot?: string | null;
  gapNote?: string | null;
  defaultFollowUp?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(args.headline.trim().slice(0, 220));
  const fi = args.founderInterpretation?.trim();
  if (fi) lines.push(`Stated: ${fi.slice(0, 280)}`);
  const rec = args.recordsSnapshot?.trim();
  if (rec) lines.push(`Records: ${rec.slice(0, 320)}`);
  const g = args.gapNote?.trim();
  if (g) lines.push(g.slice(0, 320));
  if (args.defaultFollowUp) {
    lines.push("");
    lines.push("Follow-up: Confirm definition, timeframe, and source.");
  }
  return lines.join("\n").trim().slice(0, 3500);
}
