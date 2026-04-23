import type { CandidateMeta } from "@/lib/similar-deals/types";

export function slotFromNormalized(normalized: string, idx: number): string | null {
  const parts = normalized
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (idx >= parts.length) return null;
  const v = parts[idx];
  if (!v || v === "unknown" || v === "n/a") return null;
  return v;
}

/** Structural prefilter from Phase 1 parse (no LLM retrieval slices). */
export function structuralSlotsFromParsing(parsing: Record<string, unknown> | null | undefined): {
  sector: string | null;
  stage: string | null;
  moat: string | null;
} {
  if (!parsing || typeof parsing !== "object") {
    return { sector: null, stage: null, moat: null };
  }
  const co = (parsing.company_overview ?? {}) as Record<string, unknown>;
  const sol = (parsing.solution ?? {}) as Record<string, unknown>;
  const sector = typeof co.sector_category === "string" ? co.sector_category.trim().toLowerCase() : null;
  const stage = typeof co.stage === "string" ? co.stage.trim().toLowerCase() : null;
  const moat = typeof sol.product_type === "string" ? sol.product_type.trim().toLowerCase() : null;
  return { sector, stage, moat };
}

export function filterStructurally(
  candidates: CandidateMeta[],
  querySector: string | null,
  queryStage: string | null,
  queryMoat: string | null
): CandidateMeta[] {
  const sec = querySector?.toLowerCase() ?? null;
  const stg = queryStage?.toLowerCase() ?? null;
  const moat = queryMoat?.toLowerCase() ?? null;

  const strict = candidates.filter((c) => {
    const cSector = c.sector?.toLowerCase() ?? "";
    const cStage = c.stage?.toLowerCase() ?? "";
    const cMoat = c.moat_type?.toLowerCase() ?? "";
    const sectorOk = sec ? cSector === sec : true;
    const stageOk = stg ? cStage === stg : true;
    const moatOk = moat ? cMoat.includes(moat) || moat.includes(cMoat) : true;
    return sectorOk && stageOk && moatOk;
  });
  if (strict.length > 0) return strict;

  const relaxed = candidates.filter((c) => {
    if (!sec) return true;
    return (c.sector?.toLowerCase() ?? "") === sec;
  });
  return relaxed.length > 0 ? relaxed : candidates;
}
