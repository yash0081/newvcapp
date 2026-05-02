import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fillMatrixCell } from "@/lib/diligence-matrix/matrix";
import { getAuthedUser } from "@/lib/research/db";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { dealIds?: unknown; columnIds?: unknown; allowResearch?: unknown }
    | null;
  const dealIds = Array.isArray(body?.dealIds)
    ? body.dealIds.filter((x): x is string => typeof x === "string" && Boolean(x)).slice(0, 25)
    : [];
  const columnIds = Array.isArray(body?.columnIds)
    ? body.columnIds.filter((x): x is string => typeof x === "string" && Boolean(x)).slice(0, 20)
    : [];
  if (!dealIds.length || !columnIds.length) {
    return NextResponse.json({ error: "dealIds and columnIds are required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const cells = [];
  const errors = [];
  const pairs = dealIds.flatMap((dealId) => columnIds.map((columnId) => ({ dealId, columnId })));
  const maxPairs = body?.allowResearch !== false ? 18 : 80;
  for (const { dealId, columnId } of pairs.slice(0, maxPairs)) {
      try {
        const cell = await fillMatrixCell({
          admin,
          userId: user.id,
          dealId,
          columnId,
          allowResearch: body?.allowResearch !== false,
        });
        cells.push(cell);
      } catch (e) {
        errors.push({
          dealId,
          columnId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
  }
  if (pairs.length > maxPairs) {
    errors.push({
      dealId: "",
      columnId: "",
      error: `Filled the first ${maxPairs} cells. Select a smaller batch or run again for the remaining cells.`,
    });
  }
  return NextResponse.json({ cells, errors });
}
