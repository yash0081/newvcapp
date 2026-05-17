import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  listMatrixCells,
  listMatrixColumns,
  listMatrixDeals,
  seedDefaultMatrixColumns,
} from "@/lib/diligence-matrix/matrix";

export async function GET(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const dealIdsParam = new URL(req.url).searchParams.get("dealIds");
  const dealIds = dealIdsParam
    ? dealIdsParam.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 25)
    : [];
  try {
    const [deals, columns] = await Promise.all([
      listMatrixDeals(admin, user.id),
      seedDefaultMatrixColumns(admin, user.id),
    ]);
    const cells = await listMatrixCells(admin, user.id, dealIds.length ? { dealIds } : undefined);
    return NextResponse.json({ deals, columns, cells });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load matrix";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
