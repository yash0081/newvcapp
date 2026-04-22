import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";
import { runWithTextMulti } from "../lib/gemini";

type Extracted = {
  pass_reason_enum: string | null;
  key_risks: string[];
  moat_type: string | null;
  replication_difficulty: "low" | "medium" | "high" | null;
  sector: string | null;
  stage: string | null;
  product_type: string | null;
};

const PROMPT = `Extract structured fields from pass_reason_detail for venture retrieval.

Return strict JSON only:
{
  "pass_reason_enum": "platform_risk | team | market_size | thesis_mismatch | valuation | traction | competition | regulation | go_to_market | execution | unknown",
  "key_risks": ["string", "string"],
  "moat_type": "string | null",
  "replication_difficulty": "low | medium | high | null",
  "sector": "string | null",
  "stage": "string | null",
  "product_type": "string | null"
}

Rules:
- 2-4 key_risks max; short labels (2-5 words each)
- no fluff; concise taxonomy labels
- if uncertain, prefer null or "unknown" (for pass_reason_enum only)`;

function asText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function asRiskArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeEnum(v: string | null): string | null {
  if (!v) return null;
  const t = v.toLowerCase().trim().replace(/\s+/g, "_");
  const allowed = new Set([
    "platform_risk",
    "team",
    "market_size",
    "thesis_mismatch",
    "valuation",
    "traction",
    "competition",
    "regulation",
    "go_to_market",
    "execution",
    "unknown",
  ]);
  return allowed.has(t) ? t : "unknown";
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const admin = createClient(url, key);

  const { data: deals, error } = await admin
    .from("deals")
    .select("id, company_name, pass_reason_detail, sector, stage, product_type")
    .not("pass_reason_detail", "is", null)
    .limit(5000);
  if (error) throw error;

  console.log(`Found ${(deals ?? []).length} deals with pass_reason_detail`);

  for (const d of deals ?? []) {
    const passReasonDetail = asText(d.pass_reason_detail);
    if (!passReasonDetail) continue;
    const dealId = d.id as string;
    const company = asText(d.company_name) ?? dealId;

    try {
      const raw = (await runWithTextMulti(
        PROMPT,
        [
          { label: "company_name", value: company },
          { label: "existing_sector", value: asText(d.sector) },
          { label: "existing_stage", value: asText(d.stage) },
          { label: "existing_product_type", value: asText(d.product_type) },
          { label: "pass_reason_detail", value: passReasonDetail },
        ],
        "flash_lite",
        false
      )) as Record<string, unknown>;

      const extracted: Extracted = {
        pass_reason_enum: normalizeEnum(asText(raw.pass_reason_enum)),
        key_risks: asRiskArray(raw.key_risks),
        moat_type: asText(raw.moat_type),
        replication_difficulty: (() => {
          const v = asText(raw.replication_difficulty)?.toLowerCase();
          if (v === "low" || v === "medium" || v === "high") return v;
          return null;
        })(),
        sector: asText(raw.sector),
        stage: asText(raw.stage),
        product_type: asText(raw.product_type),
      };

      const { error: upErr } = await admin
        .from("deals")
        .update({
          pass_reason_enum: extracted.pass_reason_enum,
          key_risks: extracted.key_risks.length ? extracted.key_risks : null,
          moat_type: extracted.moat_type ?? null,
          replication_difficulty: extracted.replication_difficulty ?? null,
          sector: extracted.sector ?? d.sector ?? null,
          stage: extracted.stage ?? d.stage ?? null,
          product_type: extracted.product_type ?? d.product_type ?? null,
          pass_reason: extracted.pass_reason_enum ?? null,
        })
        .eq("id", dealId);
      if (upErr) throw upErr;

      console.log("✓", company);
    } catch (e) {
      console.error("✗", company, e);
    }
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

