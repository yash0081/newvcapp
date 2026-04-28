import "server-only";
import { ingestTextAsDocument, type AdminClient } from "@/lib/research/document-ingest";

function stripHtmlToText(html: string): string {
  const s = String(html || "");
  // Drop script/style blocks early.
  const noScripts = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const noTags = noScripts.replace(/<\/?[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return decoded;
}

async function fetchUrlText(url: string, timeoutMs: number): Promise<{ text: string; contentType: string | null }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.WEB_INGEST_USER_AGENT ||
          "Mozilla/5.0 (compatible; newvcapp/1.0; +https://example.com) AppleWebKit/537.36 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
    });
    const ct = res.headers.get("content-type");
    const body = await res.text();
    const capped = body.length > 1_200_000 ? body.slice(0, 1_200_000) : body;
    const text = (ct && ct.includes("html")) || capped.includes("<html") ? stripHtmlToText(capped) : capped.trim();
    return { text, contentType: ct };
  } finally {
    clearTimeout(t);
  }
}

export async function ingestWebSourceAsDocument(args: {
  admin: AdminClient;
  userId: string;
  dealId: string;
  sourceUrl: string;
  title?: string;
  workflowId?: string;
  stepId?: string;
  timeoutMs?: number;
}): Promise<{ documentId: string } | null> {
  const sourceUrl = String(args.sourceUrl || "").trim();
  if (!sourceUrl) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const { text, contentType } = await fetchUrlText(url.toString(), Math.max(1000, Math.min(15000, args.timeoutMs ?? 6000)));
  if (!text) return null;

  return ingestTextAsDocument({
    admin: args.admin,
    userId: args.userId,
    dealId: args.dealId,
    text,
    sourceKind: "web",
    docType: "web_research",
    originalFilename: args.title ? `${args.title} (${url.hostname})` : url.hostname,
    mimeType: contentType || "text/html",
    storageBucket: "web",
    storagePathPrefix: `web/${args.userId}`,
    folderPath: "web",
    routingReason: "web_ingest",
    pageMetadata: {
      kind: "web",
      url: url.toString(),
      hostname: url.hostname,
      title: args.title ?? null,
      workflow_id: args.workflowId ?? null,
      step_id: args.stepId ?? null,
      fetched_at: new Date().toISOString(),
    },
  });
}
