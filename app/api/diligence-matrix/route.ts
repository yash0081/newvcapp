import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { listMatrixCells, listMatrixColumns, listMatrixDeals } from "@/lib/diligence-matrix/matrix";

export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  try {
    const [deals, columns, cells] = await Promise.all([
      listMatrixDeals(admin, user.id),
      listMatrixColumns(admin, user.id),
      listMatrixCells(admin, user.id),
    ]);
    return NextResponse.json({ deals, columns, cells });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load matrix";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
