import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fillMatrixCell } from "@/lib/diligence-matrix/matrix";
import { getAuthedUser } from "@/lib/research/db";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { dealIds?: unknown; columnIds?: unknown; pairs?: unknown; allowResearch?: unknown }
    | null;
  const requestedPairs = Array.isArray(body?.pairs)
    ? body.pairs
        .map((item) => {
          const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          const dealId = typeof o.dealId === "string" ? o.dealId : "";
          const columnId = typeof o.columnId === "string" ? o.columnId : "";
          return dealId && columnId ? { dealId, columnId } : null;
        })
        .filter((pair): pair is { dealId: string; columnId: string } => Boolean(pair))
        .slice(0, 80)
    : [];
  const dealIds = Array.isArray(body?.dealIds)
    ? body.dealIds.filter((x): x is string => typeof x === "string" && Boolean(x)).slice(0, 25)
    : [];
  const columnIds = Array.isArray(body?.columnIds)
    ? body.columnIds.filter((x): x is string => typeof x === "string" && Boolean(x)).slice(0, 20)
    : [];
  if (!requestedPairs.length && (!dealIds.length || !columnIds.length)) {
    return NextResponse.json({ error: "pairs or dealIds and columnIds are required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const pairs = requestedPairs.length ? requestedPairs : dealIds.flatMap((dealId) => columnIds.map((columnId) => ({ dealId, columnId })));
  const maxPairs = body?.allowResearch !== false ? 12 : 80;
  const selectedPairs = pairs.slice(0, maxPairs);
  const results = await Promise.all(selectedPairs.map(async ({ dealId, columnId }) => {
      try {
        const cell = await fillMatrixCell({
          admin,
          userId: user.id,
          dealId,
          columnId,
          allowResearch: body?.allowResearch !== false,
          peerDealIds: dealIds.filter((id) => id !== dealId),
        });
        return { cell, error: null };
      } catch (e) {
        return {
          cell: null,
          error: {
            dealId,
            columnId,
            error: e instanceof Error ? e.message : String(e),
          },
        };
      }
  }));
  const cells = results.map((result) => result.cell).filter(Boolean);
  const errors = results.map((result) => result.error).filter(Boolean);
  if (pairs.length > maxPairs) {
    errors.push({
      dealId: "",
      columnId: "",
      error: `Filled the first ${maxPairs} cells. Select a smaller batch or run again for the remaining cells.`,
    });
  }
  return NextResponse.json({ cells, errors });
}
