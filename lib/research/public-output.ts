import { stripModelPromptEcho } from "@/lib/commentary";
import { stripMarkdownText } from "@/lib/plain-text";
import type { ResearchSource } from "@/lib/research/types";

/** Substrings that indicate model/prompt echo rather than a real citation. */
const INTERNAL_SOURCE_TEXT_RE =
  /\b(pruning|guardrail|sourcestrategy|schema guide|deal intel layer|suggestedstepupdates|strict json|lightweight review|intent and pruning|planner and pruning|task-level pruning|source_constrained|broad_web|vertexrun|google search grounding|canonical deal intel|user preference guardrail|do not expand the research scope|remove schema buckets|output schema|search execution list)\b/i;

const INTERNAL_NOTES_CUT_RE = [
  /\n+(You are (?:the |a )?(?:intent|lightweight|research|VC)[\s\S]*)$/i,
  /\n+(Return strict JSON[\s\S]*)$/i,
  /\n+(\*{0,2}OUTPUT SCHEMA\*{0,2}:[\s\S]*)$/i,
  /\n+(RULES:[\s\S]*)$/i,
  /\n+(CONSTRAINTS:[\s\S]*)$/i,
  /\n+("sources"\s*:\s*\[[\s\S]*)$/i,
];

function looksLikeInternalText(value: string): boolean {
  const t = value.trim();
  if (!t || t.length < 8) return false;
  if (INTERNAL_SOURCE_TEXT_RE.test(t)) return true;
  if (/^[-*]\s+(Do not|Reject|Keep only|Use plain text|Keyword and regex)/i.test(t)) return true;
  if (/^\{[\s\S]*"(profile|needsWeb|needsWorkflow|updates)"\s*:/.test(t)) return true;
  return false;
}

export function isValidPublicSourceUrl(url: string): boolean {
  const raw = url.trim();
  if (!raw || raw.length > 2048) return false;
  if (looksLikeInternalText(raw)) return false;
  if (/^https?:\/\/\.{3}|^https?:\/\/example\.com\b|<\.\.\.>|placeholder/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local")) return false;
    if (!host.includes(".")) return false;
    if (/^(rules|constraints|schema|pruning|guardrails?)\./i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function cleanSourceField(value: string | undefined, maxLen: number): string | undefined {
  if (!value) return undefined;
  let out = stripMarkdownText(value).trim();
  if (!out || looksLikeInternalText(out)) return undefined;
  out = stripModelPromptEcho(out);
  if (!out || looksLikeInternalText(out)) return undefined;
  return out.slice(0, maxLen);
}

export function sanitizeResearchSource(source: ResearchSource): ResearchSource | null {
  const url = typeof source.url === "string" ? source.url.trim() : "";
  if (!isValidPublicSourceUrl(url)) return null;
  const rawTitle = typeof source.title === "string" ? source.title.trim() : "";
  const rawSnippet = typeof source.snippet === "string" ? source.snippet.trim() : "";
  if (rawTitle && looksLikeInternalText(rawTitle)) return null;
  if (rawSnippet && looksLikeInternalText(rawSnippet)) return null;
  const title = cleanSourceField(source.title, 300);
  const snippet = cleanSourceField(source.snippet, 800);
  return { url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) };
}

export function sanitizeResearchSources(sources: ResearchSource[] | null | undefined): ResearchSource[] {
  if (!Array.isArray(sources)) return [];
  const out: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const clean = sanitizeResearchSource(source);
    if (!clean || seen.has(clean.url)) continue;
    seen.add(clean.url);
    out.push(clean);
    if (out.length >= 8) break;
  }
  return out;
}

export function sanitizeResearchNotes(notes: string): string {
  let out = stripMarkdownText(notes || "");
  out = stripModelPromptEcho(out);
  for (const re of INTERNAL_NOTES_CUT_RE) {
    out = out.replace(re, "").trimEnd();
  }
  if (looksLikeInternalText(out) && out.length < 400) return "";
  return out.trim();
}

/** Server-only planner steering; never show in sources, citations, or user focus. */
export function buildPlannerGuidanceBlock(args: {
  message: string;
  useCriteria: boolean;
  useSimilarCompanies: boolean;
}): string {
  const needsAnalysisFrame =
    args.useCriteria ||
    args.useSimilarCompanies ||
    /analysis|analy[sz]e|deep|diligence|memo|investment|thesis|risk|negative|competitor|market|founder|traction/i.test(args.message);
  if (!needsAnalysisFrame) return "";
  return [
    "Use diligence-grade evidence standards and the default Deal Intel analysis layer as background quality guidance only.",
    "Do not expand the research scope beyond the user's requested topics. Remove schema buckets, source families, and steps that do not directly answer the request.",
    "Use saved workspace context, internal database signals, documents, and web research together.",
    "Respect user investment preferences and website preferences for source choice. Keep facts separate from preferences; preserve literal numbers; cite sources; call out unknowns instead of guessing.",
  ].join(" ");
}

export function buildPlannerFocus(userFocus: string, guidanceBlock: string): string {
  const focus = userFocus.trim();
  if (!guidanceBlock.trim()) return focus;
  if (!focus) return guidanceBlock.trim();
  return `${focus}\n\n${guidanceBlock.trim()}`;
}
