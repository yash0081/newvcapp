/**
 * Keep in sync with lib/copilot/steering-focus.ts — extension bundle cannot import app lib.
 * When the user sets a steering / focus note, drop suggestions that are off-topic.
 */

const FUNDING_FOCUS = /\b(fund|funding|invest|investor|investment|round|series|valuation|venture|capital|seed|financ|cap\s*table)\b/i;
const TEAM_FOCUS = /\b(founder|founders|team|ceo|cto|cfo|leadership|executive|bio|bios|background|management)\b/i;
const PRODUCT_FOCUS = /\b(product|platform|tech|technology|feature|solution|pricing|roadmap)\b/i;
const TRACTION_FOCUS = /\b(traction|revenue|customer|customers|logo|growth|arr|mrr|users)\b/i;
const MARKET_FOCUS = /\b(market|competitor|competition|tam|icp|buyer|alternative)\b/i;
const LEGAL_RISK_FOCUS = /\b(legal|risk|lawsuit|compliance|security|privacy|regulatory)\b/i;

const FUNDING_SIGNAL = /\b(fund|funding|invest|investor|investment|raised|round|series|seed|venture|valuation|capital|financ|million|billion|m\s*&\s*a|ipo)\b|\$\s*[\d.,]+|[\d.,]+\s*(m|mm|million|b|bn|billion)\b/i;
const TEAM_SIGNAL = /\b(founder|co-?founder|ceo|cto|cfo|coo|chief|president|executive|leadership|team|bio|education|university|degree)\b/i;
const PRODUCT_SIGNAL = /\b(product|platform|solution|feature|technology|pricing|sku|api)\b/i;
const TRACTION_SIGNAL = /\b(traction|revenue|arr|mrr|customer|client|logo|growth|user|deployment)\b/i;
const MARKET_SIGNAL = /\b(competitor|competition|market|alternative|substitute|tam|segment)\b/i;
const LEGAL_SIGNAL = /\b(legal|risk|lawsuit|litigation|compliance|gdpr|hipaa|soc\s*2|regulatory)\b/i;

type FocusRule = { focus: RegExp; signal: RegExp };

const FOCUS_RULES: FocusRule[] = [
  { focus: FUNDING_FOCUS, signal: FUNDING_SIGNAL },
  { focus: TEAM_FOCUS, signal: TEAM_SIGNAL },
  { focus: PRODUCT_FOCUS, signal: PRODUCT_SIGNAL },
  { focus: TRACTION_FOCUS, signal: TRACTION_SIGNAL },
  { focus: MARKET_FOCUS, signal: MARKET_SIGNAL },
  { focus: LEGAL_RISK_FOCUS, signal: LEGAL_SIGNAL },
];

function normalizeSteeringBlob(summary: string, snippet: string, linkUrl: string | null | undefined): string {
  return `${summary}\n${snippet}\n${linkUrl ?? ""}`.toLowerCase();
}

export function suggestionMatchesSteeringFocus(args: {
  summary: string;
  snippet: string;
  linkUrl?: string | null;
  steeringNote: string;
}): boolean {
  const steering = args.steeringNote.trim();
  if (!steering) return true;

  const blob = normalizeSteeringBlob(args.summary, args.snippet, args.linkUrl);
  const steerLower = steering.toLowerCase();
  if (blob.includes(steerLower)) return true;

  for (const { focus, signal } of FOCUS_RULES) {
    if (focus.test(steering)) {
      return signal.test(blob);
    }
  }

  const tokens = steering
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  if (tokens.length === 0) return true;
  return tokens.some((t) => blob.includes(t));
}
