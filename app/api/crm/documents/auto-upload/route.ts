import { createHash, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { extractPdfTextByPage } from "@/lib/deal-intel/pdf-text";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { getResearchModel } from "@/lib/research/research-model-env";
import { vertexRunWithTextMulti } from "@/lib/vertex";

const BUCKET = process.env.CRM_DOCS_BUCKET || "crm_docs";

type DealRow = {
  id: string;
  created_at?: string;
  metadata: Record<string, unknown> | null;
};

type RoutingDecision = {
  dealId: string | null;
  companyName: string;
  website: string | null;
  confidence: number;
  reason: string;
};

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeFilename(name: string): string {
  const trimmed = name.trim() || "document.pdf";
  return trimmed.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function dealName(deal: DealRow): string {
  const meta = safeMeta(deal.metadata);
  return asString(meta.company_name) || "Untitled company";
}

function dealWebsite(deal: DealRow): string {
  const meta = safeMeta(deal.metadata);
  return asString(meta.website);
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(pdf|docx?|pptx?|txt|md)$/g, " ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|ai|technologies|technology|labs)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalizeName(value).replaceAll(" ", "");
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function filenameExistingMatch(filename: string, deals: DealRow[]): RoutingDecision | null {
  const haystack = compact(filename);
  if (!haystack) return null;
  for (const deal of deals) {
    const name = dealName(deal);
    const needle = compact(name);
    if (needle.length >= 4 && haystack.includes(needle)) {
      return {
        dealId: deal.id,
        companyName: name,
        website: dealWebsite(deal) || null,
        confidence: 0.94,
        reason: `Filename matches existing company "${name}".`,
      };
    }
  }
  return null;
}

function textExistingMatch(text: string, deals: DealRow[]): RoutingDecision | null {
  const haystack = compact(text.slice(0, 16_000));
  if (!haystack) return null;
  let best: RoutingDecision | null = null;
  for (const deal of deals) {
    const name = dealName(deal);
    const needle = compact(name);
    if (needle.length >= 5 && haystack.includes(needle)) {
      const confidence = needle.length >= 8 ? 0.78 : 0.68;
      if (!best || confidence > best.confidence) {
        best = {
          dealId: deal.id,
          companyName: name,
          website: dealWebsite(deal) || null,
          confidence,
          reason: `Document text mentions existing company "${name}".`,
        };
      }
    }
  }
  return best;
}

function normalizeWebsite(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s) && !/^www\./i.test(s) && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

async function inferCompany(args: {
  filename: string;
  textSample: string;
  deals: DealRow[];
}): Promise<RoutingDecision> {
  const filenameMatch = filenameExistingMatch(args.filename, args.deals);
  if (filenameMatch) return filenameMatch;

  try {
    const raw = await vertexRunWithTextMulti(
      getResearchModel("flash_lite"),
      `Identify which company this uploaded document belongs to for a CRM.

Return strict JSON:
{
  "existingDealId": string | null,
  "companyName": string | null,
  "website": string | null,
  "confidence": number,
  "reason": string
}

Rules:
- If the document clearly belongs to one of the existing companies, set existingDealId.
- If it clearly belongs to a new company, set companyName and confidence >= 0.72.
- If the document only mentions a company as a customer, competitor, investor, or example, do not route to that company.
- If unclear, set confidence <= 0.49 and companyName null.
- Prefer the company that is the subject of the document, not a person, investor, author, or vendor.`,
      [
        {
          label: "Existing companies",
          value: args.deals.slice(0, 100).map((deal) => ({
            id: deal.id,
            name: dealName(deal),
            website: dealWebsite(deal),
          })),
        },
        { label: "Uploaded filename", value: args.filename },
        { label: "Extracted document text sample", value: args.textSample.slice(0, 18_000) },
      ],
      false,
    );
    const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
    const confidence = clampConfidence(parsed?.confidence);
    const existingDealId = asString(parsed?.existingDealId);
    const existing = existingDealId ? args.deals.find((deal) => deal.id === existingDealId) ?? null : null;
    const companyName = asString(parsed?.companyName);
    const website = normalizeWebsite(asString(parsed?.website));
    const reason = asString(parsed?.reason) || "LLM routing decision.";

    if (existing && confidence >= 0.55) {
      return {
        dealId: existing.id,
        companyName: dealName(existing),
        website: dealWebsite(existing) || website,
        confidence,
        reason,
      };
    }

    if (companyName) {
      const byName = args.deals.find((deal) => compact(dealName(deal)) === compact(companyName));
      if (byName && confidence >= 0.55) {
        return {
          dealId: byName.id,
          companyName: dealName(byName),
          website: dealWebsite(byName) || website,
          confidence,
          reason,
        };
      }
      return { dealId: null, companyName, website, confidence, reason };
    }
  } catch (e) {
    console.warn("smart document intake LLM routing failed:", e);
  }

  const textMatch = textExistingMatch(args.textSample, args.deals);
  if (textMatch) return textMatch;

  return {
    dealId: null,
    companyName: "",
    website: null,
    confidence: 0,
    reason: "Could not confidently identify the company from the filename or extracted text.",
  };
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No PDF file provided" }, { status: 400 });
  }

  const originalName =
    typeof (file as File).name === "string" && (file as File).name.trim() ? (file as File).name : "document.pdf";
  const mimeType = typeof (file as File).type === "string" && (file as File).type ? (file as File).type : "application/pdf";
  const isPdf = mimeType.includes("pdf") || originalName.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json({ error: "Smart intake currently supports PDF uploads." }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);
  const maxBytes = Number(process.env.CRM_DOCS_PDF_MAX_BYTES) || 25 * 1024 * 1024;
  if (pdfBuffer.length < 1 || pdfBuffer.length > maxBytes) {
    return NextResponse.json({ error: `PDF size must be between 1 and ${maxBytes} bytes` }, { status: 400 });
  }

  const admin = createAdminClient();
  const dealsRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, created_at, metadata")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (dealsRes.error) {
    return NextResponse.json({ error: dealsRes.error.message || "Failed to load companies" }, { status: 500 });
  }

  let pages: Array<{ pageNumber: number; text: string }> = [];
  try {
    pages = await extractPdfTextByPage(pdfBuffer);
  } catch (e) {
    console.warn("smart document intake PDF text extraction failed:", e);
  }

  const textSample = pages
    .slice(0, 10)
    .map((page) => `Page ${page.pageNumber}\n${page.text}`)
    .join("\n\n")
    .slice(0, 20_000);

  const routing = await inferCompany({
    filename: originalName,
    textSample,
    deals: (dealsRes.data ?? []) as DealRow[],
  });

  const existingDeal = routing.dealId ? ((dealsRes.data ?? []) as DealRow[]).find((deal) => deal.id === routing.dealId) ?? null : null;
  const shouldCreate = !routing.dealId && routing.companyName && routing.confidence >= 0.72;
  if (!existingDeal && !shouldCreate) {
    return NextResponse.json(
      {
        error:
          "I could not confidently identify which company this belongs to. Try uploading from a company workspace, or rename the PDF with the company name.",
        routing,
      },
      { status: 422 },
    );
  }

  let dealId = existingDeal?.id ?? "";
  let createdDeal = false;
  if (!dealId) {
    const ins = await admin
      .schema("deal_intel")
      .from("deal")
      .insert({
        user_id: user.id,
        metadata: {
          company_name: routing.companyName,
          website: routing.website,
          crm_stage: "screened",
          source: "smart_document_intake",
        },
      })
      .select("id")
      .single();
    if (ins.error || !ins.data?.id) {
      return NextResponse.json({ error: ins.error?.message || "Failed to create company" }, { status: 500 });
    }
    dealId = ins.data.id as string;
    createdDeal = true;
  }

  const documentId = randomUUID();
  const filename = safeFilename(originalName);
  const yyyyMm = new Date().toISOString().slice(0, 7);
  const storagePath = `companies/${dealId}/${yyyyMm}/${documentId}/${filename}`;

  const upload = await admin.storage.from(BUCKET).upload(storagePath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upload.error) {
    return NextResponse.json(
      { error: upload.error.message || `Storage upload failed. Ensure bucket '${BUCKET}' exists.` },
      { status: 500 },
    );
  }

  const digest = sha256(pdfBuffer);
  const status = pages.length ? "parsed" : "uploaded";
  let needsParse = !pages.length;
  let responseStatus = status;
  const inserted = await admin
    .schema("deal_intel")
    .from("document")
    .insert({
      id: documentId,
      user_id: user.id,
      deal_id: dealId,
      source_kind: "company_document",
      doc_type: "smart_upload",
      original_filename: originalName,
      mime_type: "application/pdf",
      byte_size: pdfBuffer.length,
      sha256: digest,
      storage_provider: "supabase_storage",
      storage_bucket: BUCKET,
      storage_path: storagePath,
      folder_path: "Company documents",
      status,
      error_message: null,
      routing_confidence: routing.confidence,
      routing_reason: routing.reason,
    })
    .select("id")
    .single();

  if (inserted.error || !inserted.data?.id) {
    try {
      await admin.storage.from(BUCKET).remove([storagePath]);
    } catch {
      /* ignore cleanup failures */
    }
    return NextResponse.json({ error: inserted.error?.message || "Failed to create document row" }, { status: 500 });
  }

  if (pages.length) {
    const pageRows = pages.map((page) => ({
      document_id: documentId,
      page_number: page.pageNumber,
      text: page.text,
      char_count: page.text.length,
      metadata: { routed_by: "smart_intake" },
    }));
    const pageInsert = await admin.schema("deal_intel").from("document_page").insert(pageRows);
    if (pageInsert.error) {
      needsParse = true;
      responseStatus = "uploaded";
      await admin
        .schema("deal_intel")
        .from("document")
        .update({ status: "uploaded", error_message: null })
        .eq("id", documentId)
        .eq("user_id", user.id);
    }
  }

  return NextResponse.json({
    documentId,
    dealId,
    companyName: existingDeal ? dealName(existingDeal) : routing.companyName,
    createdDeal,
    confidence: routing.confidence,
    routingReason: routing.reason,
    needsParse,
    status: responseStatus,
  });
}
