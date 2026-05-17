import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMatrixView, listMatrixViews } from "@/lib/diligence-matrix/views";
import { getAuthedUser } from "@/lib/research/db";

export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const views = await listMatrixViews(createAdminClient(), user.id);
    return NextResponse.json({ views });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load matrix views";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    dealIds?: unknown;
    columnIds?: unknown;
  } | null;
  const dealIds = Array.isArray(body?.dealIds)
    ? body.dealIds.filter((x): x is string => typeof x === "string" && Boolean(x))
    : [];
  const columnIds = Array.isArray(body?.columnIds)
    ? body.columnIds.filter((x): x is string => typeof x === "string" && Boolean(x))
    : [];
  const name = typeof body?.name === "string" ? body.name : "Untitled matrix";
  try {
    const view = await createMatrixView(createAdminClient(), user.id, { name, dealIds, columnIds });
    return NextResponse.json({ view });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save matrix";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
