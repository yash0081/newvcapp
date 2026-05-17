import "server-only";
import type { Extracted, ExtractedKeyValue } from "@/lib/copilot/types";

const MAX_VISIBLE_TEXT_CHARS = 5000;
const MAX_KEY_VALUE_CLAIMS = 12;
const MAX_OUTBOUND_LINKS = 36;

function normalizeKeyValueClaims(v: unknown): ExtractedKeyValue[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedKeyValue[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim().slice(0, 200) : "";
    const value = typeof r.value === "string" ? r.value.trim().slice(0, 400) : "";
    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : 0.5;
    if (!key || !value) continue;
    out.push({ key, value, confidence });
    if (out.length >= MAX_KEY_VALUE_CLAIMS) break;
  }
  return out;
}

function normalizeOutboundLinks(v: unknown): Array<{ url: string; text: string; heading?: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; text: string; heading?: string }> = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const urlRaw = typeof r.url === "string" ? r.url.trim() : "";
    if (!urlRaw) continue;
    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalizedUrl = parsed.toString();
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const text = typeof r.text === "string" ? r.text.trim().slice(0, 120) : "";
    const heading = typeof r.heading === "string" ? r.heading.trim().slice(0, 120) : undefined;
    out.push({ url: normalizedUrl, text, heading });
    if (out.length >= MAX_OUTBOUND_LINKS) break;
  }
  return out;
}

function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw === "string" && raw.trim()) {
      out.push(raw.trim().slice(0, 200));
    }
  }
  return out;
}

function detectPageType(hostname: string, visibleText: string): string {
  const host = hostname.toLowerCase();
  const text = visibleText.toLowerCase();
  
  if (/crunchbase|pitchbook|wellfound|linkedin|angel\.co/.test(host)) return "database";
  if (/wikipedia|britannica/.test(host)) return "reference";
  if (/techcrunch|reuters|bloomberg|forbes|wsj/.test(host)) return "news";
  if (/github|gitlab|bitbucket/.test(host)) return "code";
  if (/producthunt|g2|capterra/.test(host)) return "review";
  if (/about|team|company/.test(host) && /mission|values|story/.test(text)) return "company_site";
  if (/pricing|plans|subscription/.test(text)) return "pricing_page";
  if (/blog|news|press/.test(host) || /posted|published/.test(text)) return "article";
  if (/product|features|specs/.test(text)) return "product_page";
  if (/list|top|best|review/.test(text)) return "listicle";
  
  return "unknown";
}

function extractNavigationStructure(visibleText: string): { nav_bars: string[]; sidebars: string[]; breadcrumbs: string[] } {
  const navBars: string[] = [];
  const sidebars: string[] = [];
  const breadcrumbs: string[] = [];
  
  const lines = visibleText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/nav|menu|navigation/i.test(trimmed)) navBars.push(trimmed.slice(0, 200));
    if (/sidebar|aside/i.test(trimmed)) sidebars.push(trimmed.slice(0, 200));
    if (/breadcrumb|crumb/i.test(trimmed)) breadcrumbs.push(trimmed.slice(0, 200));
  }
  
  return { nav_bars: navBars.slice(0, 5), sidebars: sidebars.slice(0, 5), breadcrumbs: breadcrumbs.slice(0, 3) };
}

function extractInteractiveElements(visibleText: string): { accordions: string[]; tabs: string[]; modals: string[]; expandable_sections: string[] } {
  const accordions: string[] = [];
  const tabs: string[] = [];
  const modals: string[] = [];
  const expandableSections: string[] = [];
  
  const lines = visibleText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/accordion|collapse|expand/i.test(trimmed)) accordions.push(trimmed.slice(0, 200));
    if (/tab|switch/i.test(trimmed)) tabs.push(trimmed.slice(0, 200));
    if (/modal|dialog|popup/i.test(trimmed)) modals.push(trimmed.slice(0, 200));
    if (/expand|more|show|hide/i.test(trimmed)) expandableSections.push(trimmed.slice(0, 200));
  }
  
  return { 
    accordions: accordions.slice(0, 5), 
    tabs: tabs.slice(0, 5), 
    modals: modals.slice(0, 3), 
    expandable_sections: expandableSections.slice(0, 5) 
  };
}

function extractContentDensityRegions(visibleText: string): { high: string[]; medium: string[]; low: string[] } {
  const high: string[] = [];
  const medium: string[] = [];
  const low: string[] = [];
  
  const lines = visibleText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 10) continue;
    
    // High density: contains numbers, dates, metrics, detailed information
    if (/\d+|\$|%,|facts|data|statistics|metrics/i.test(trimmed)) {
      high.push(trimmed.slice(0, 300));
    } 
    // Medium density: descriptive text
    else if (trimmed.length > 50 && /[a-z]/i.test(trimmed)) {
      medium.push(trimmed.slice(0, 300));
    }
    // Low density: navigation, short labels
    else {
      low.push(trimmed.slice(0, 300));
    }
  }
  
  return { high: high.slice(0, 10), medium: medium.slice(0, 10), low: low.slice(0, 10) };
}

function extractSemanticSections(visibleText: string): { headers: string[]; body: string[]; footer: string[]; sidebar: string[] } {
  const headers: string[] = [];
  const body: string[] = [];
  const footer: string[] = [];
  const sidebar: string[] = [];
  
  const lines = visibleText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^h[1-6]|header|title/i.test(trimmed)) headers.push(trimmed.slice(0, 200));
    if (/footer|copyright|contact/i.test(trimmed)) footer.push(trimmed.slice(0, 200));
    if (/sidebar|aside/i.test(trimmed)) sidebar.push(trimmed.slice(0, 200));
    else if (trimmed.length > 20) body.push(trimmed.slice(0, 300));
  }
  
  return { 
    headers: headers.slice(0, 5), 
    body: body.slice(0, 15), 
    footer: footer.slice(0, 3), 
    sidebar: sidebar.slice(0, 5) 
  };
}

/**
 * Normalizes a client-supplied DOM snapshot into the same {@link Extracted}
 * shape the vision pipeline produces. Used when the Chrome extension sends
 * pre-extracted DOM text instead of a screenshot, so downstream analysis
 * code stays unchanged.
 */
export function normalizeExtractedSnapshot(input: {
  visible_text?: unknown;
  page_title?: unknown;
  hostname?: unknown;
  key_value_claims?: unknown;
  outbound_links?: unknown;
  // Optional semantic DOM fields from extension
  page_type?: unknown;
  navigation_structure?: unknown;
  interactive_elements?: unknown;
  content_density_regions?: unknown;
  semantic_sections?: unknown;
}): Extracted | null {
  const visible_text = typeof input?.visible_text === "string" ? input.visible_text.slice(0, MAX_VISIBLE_TEXT_CHARS) : "";
  if (!visible_text || visible_text.length < 10) return null;

  const hostname = typeof input?.hostname === "string" ? input.hostname.toLowerCase().slice(0, 240) : "";

  return {
    visible_text,
    page_title: typeof input?.page_title === "string" ? input.page_title.slice(0, 240) : undefined,
    hostname,
    key_value_claims: normalizeKeyValueClaims(input?.key_value_claims),
    outbound_links: normalizeOutboundLinks(input?.outbound_links),
    // Semantic DOM extraction - use extension-provided data if available, otherwise infer from visible_text
    page_type: typeof input?.page_type === "string" ? input.page_type : detectPageType(hostname, visible_text),
    navigation_structure: input?.navigation_structure && typeof input.navigation_structure === "object" 
      ? {
          nav_bars: normalizeStringArray((input.navigation_structure as Record<string, unknown>).nav_bars),
          sidebars: normalizeStringArray((input.navigation_structure as Record<string, unknown>).sidebars),
          breadcrumbs: normalizeStringArray((input.navigation_structure as Record<string, unknown>).breadcrumbs),
        }
      : extractNavigationStructure(visible_text),
    interactive_elements: input?.interactive_elements && typeof input.interactive_elements === "object"
      ? {
          accordions: normalizeStringArray((input.interactive_elements as Record<string, unknown>).accordions),
          tabs: normalizeStringArray((input.interactive_elements as Record<string, unknown>).tabs),
          modals: normalizeStringArray((input.interactive_elements as Record<string, unknown>).modals),
          expandable_sections: normalizeStringArray((input.interactive_elements as Record<string, unknown>).expandable_sections),
        }
      : extractInteractiveElements(visible_text),
    content_density_regions: input?.content_density_regions && typeof input.content_density_regions === "object"
      ? {
          high: normalizeStringArray((input.content_density_regions as Record<string, unknown>).high),
          medium: normalizeStringArray((input.content_density_regions as Record<string, unknown>).medium),
          low: normalizeStringArray((input.content_density_regions as Record<string, unknown>).low),
        }
      : extractContentDensityRegions(visible_text),
    semantic_sections: input?.semantic_sections && typeof input.semantic_sections === "object"
      ? {
          headers: normalizeStringArray((input.semantic_sections as Record<string, unknown>).headers),
          body: normalizeStringArray((input.semantic_sections as Record<string, unknown>).body),
          footer: normalizeStringArray((input.semantic_sections as Record<string, unknown>).footer),
          sidebar: normalizeStringArray((input.semantic_sections as Record<string, unknown>).sidebar),
        }
      : extractSemanticSections(visible_text),
  };
}
