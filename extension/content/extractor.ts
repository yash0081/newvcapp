import { MAX_OUTBOUND_LINKS, MAX_SNAPSHOT_TEXT_CHARS } from "@shared/config";
import type { DomKeyValue, DomSnapshot } from "@shared/types";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NAV",
  "FOOTER",
  "ASIDE",
  "NOSCRIPT",
  "FORM",
  "IFRAME",
  "SVG",
  "CANVAS",
  "TEMPLATE",
  "OBJECT",
  "EMBED",
]);

const PASSWORD_LIKE = /(^|[^a-z])(password|otp|verify|secret|api[-_ ]key|token|bearer|authorization)/i;

export type SnapshotScope = "viewport" | "full";

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  return true;
}

function isInViewportBand(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  const top = -200;
  const bottom = window.innerHeight + 200;
  return rect.bottom >= top && rect.top <= bottom;
}

function pickRoot(): Element {
  return (
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector("[role='main']") ||
    document.body
  );
}

function collectVisibleText(root: Element): string {
  const out: string[] = [];
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      const txt = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!txt) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null = walker.nextNode();
  while (n) {
    const txt = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (txt) {
      if (!PASSWORD_LIKE.test(txt) || txt.length > 240) {
        out.push(txt);
        total += txt.length + 1;
        if (total >= MAX_SNAPSHOT_TEXT_CHARS) break;
      }
    }
    n = walker.nextNode();
  }
  return out.join("\n").slice(0, MAX_SNAPSHOT_TEXT_CHARS);
}

function collectVisibleViewportText(root: Element): string {
  const inBand: string[] = [];
  const fallback: string[] = [];
  let total = 0;
  const seen = new Set<string>();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      const txt = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!txt) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let n: Node | null = walker.nextNode();
  while (n) {
    const txt = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    const parent = n.parentElement;
    if (txt && parent && (!PASSWORD_LIKE.test(txt) || txt.length > 240)) {
      if (!seen.has(txt)) {
        seen.add(txt);
        if (isInViewportBand(parent)) {
          inBand.push(txt);
          total += txt.length + 1;
          if (total >= MAX_SNAPSHOT_TEXT_CHARS) break;
        } else {
          fallback.push(txt);
        }
      }
    }
    n = walker.nextNode();
  }

  if (total < MAX_SNAPSHOT_TEXT_CHARS) {
    for (const txt of fallback) {
      inBand.push(txt);
      total += txt.length + 1;
      if (total >= MAX_SNAPSHOT_TEXT_CHARS) break;
    }
  }

  return inBand.join("\n").slice(0, MAX_SNAPSHOT_TEXT_CHARS);
}

function clean(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

const MAX_KEY_VALUE_CLAIMS = 8;

function collectKeyValuePairs(root: Element): DomKeyValue[] {
  const out: DomKeyValue[] = [];
  const seen = new Set<string>();

  for (const dl of Array.from(root.querySelectorAll("dl"))) {
    const children = Array.from(dl.children);
    for (let i = 0; i < children.length - 1; i += 1) {
      const dt = children[i];
      const dd = children[i + 1];
      if (dt.tagName !== "DT" || dd.tagName !== "DD") continue;
      const key = clean(dt.textContent ?? "", 80);
      const value = clean(dd.textContent ?? "", 200);
      if (!key || !value) continue;
      const k = `${key}::${value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key, value, confidence: 0.7 });
      if (out.length >= MAX_KEY_VALUE_CLAIMS) return out;
    }
  }

  for (const row of Array.from(root.querySelectorAll("table tr"))) {
    if (out.length >= MAX_KEY_VALUE_CLAIMS) break;
    const cells = Array.from(row.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
    if (cells.length !== 2) continue;
    const key = clean(cells[0].textContent ?? "", 80);
    const value = clean(cells[1].textContent ?? "", 200);
    if (!key || !value || key.length > 80) continue;
    const k = `${key}::${value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key, value, confidence: 0.6 });
  }

  if (out.length < MAX_KEY_VALUE_CLAIMS) {
    const text = collectVisibleText(root);
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z][\w &/\-\.]{2,40}):\s+(.{2,200})$/);
      if (!m) continue;
      const key = clean(m[1], 80);
      const value = clean(m[2], 200);
      const k = `${key}::${value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key, value, confidence: 0.4 });
      if (out.length >= MAX_KEY_VALUE_CLAIMS) break;
    }
  }

  return out;
}

function getNearestHeading(el: Element): string | null {
  let prev = el.previousElementSibling;
  while (prev) {
    if (/^H[1-6]$/.test(prev.tagName)) return prev.textContent?.trim() || null;
    const childHeading = prev.querySelector("h1, h2, h3, h4, h5, h6");
    if (childHeading) return childHeading.textContent?.trim() || null;
    prev = prev.previousElementSibling;
  }
  if (el.parentElement) return getNearestHeading(el.parentElement);
  return null;
}

function collectOutboundLinks(root: Element, scope: SnapshotScope): Array<{ url: string; text: string; heading?: string }> {
  const out: Array<{ url: string; text: string; heading?: string }> = [];
  const seen = new Set<string>();
  for (const link of Array.from(root.querySelectorAll("a[href]"))) {
    if (!isVisible(link)) continue;
    if (scope === "viewport" && !isInViewportBand(link)) continue;
    const href = (link.getAttribute("href") ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(href, location.href);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    const text = clean(link.textContent ?? "", 120);
    if (!text) continue;
    seen.add(normalized);
    const heading = clean(getNearestHeading(link) ?? "", 120);
    out.push({ url: normalized, text, heading: heading || undefined });
    if (out.length >= MAX_OUTBOUND_LINKS) break;
  }
  return out;
}

function collectViewedElements(root: Element, scope: SnapshotScope): string[] {
  if (scope === "full") return [];
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        if (!isInViewportBand(el)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });

  let n: Node | null = walker.nextNode();
  while (n) {
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag.startsWith("h") || tag === "p" || tag === "li") {
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (txt.length > 5) {
        out.push(`${tag}:${txt}`);
      }
    }
    if (out.length >= 40) break;
    n = walker.nextNode();
  }
  return out;
}

export function extractDomSnapshot(opts?: { scope?: SnapshotScope }): DomSnapshot {
  const scope = opts?.scope ?? "viewport";
  const root = pickRoot();
  const visible_text = scope === "viewport" ? collectVisibleViewportText(root) : collectVisibleText(root);
  const page_title = clean(document.title ?? "", 240);
  const hostname = location.hostname.toLowerCase();
  const url = location.href;
  const key_value_claims = collectKeyValuePairs(root);
  const outbound_links = collectOutboundLinks(root, scope);
  const viewed_elements = collectViewedElements(root, scope);
  return {
    visible_text,
    page_title,
    hostname,
    url,
    key_value_claims,
    outbound_links,
    viewed_elements,
  };
}

/** Compute a cheap fingerprint of the snapshot so we can suppress duplicate observes. */
export function fingerprintSnapshot(s: DomSnapshot, scope: SnapshotScope = "viewport"): string {
  const sample = s.visible_text.slice(0, 1200);
  let h = 0;
  for (let i = 0; i < sample.length; i += 1) {
    h = (h << 5) - h + sample.charCodeAt(i);
    h |= 0;
  }
  const scrollKey = scope === "viewport" ? `|${Math.round(window.scrollY / 250)}` : "";
  return `${s.hostname}|${s.url}|${h}|${sample.length}${scrollKey}`;
}
