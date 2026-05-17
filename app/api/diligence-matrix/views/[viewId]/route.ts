import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteMatrixView, updateMatrixView } from "@/lib/diligence-matrix/views";
import { getAuthedUser } from "@/lib/research/db";

export async function PATCH(req: Request, ctx: { params: Promise<{ viewId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { viewId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    dealIds?: unknown;
    columnIds?: unknown;
  } | null;
  const input: { name?: string; dealIds?: string[]; columnIds?: string[] } = {};
  if (typeof body?.name === "string") input.name = body.name;
  if (Array.isArray(body?.dealIds)) {
    input.dealIds = body.dealIds.filter((x): x is string => typeof x === "string" && Boolean(x));
  }
  if (Array.isArray(body?.columnIds)) {
    input.columnIds = body.columnIds.filter((x): x is string => typeof x === "string" && Boolean(x));
  }
  try {
    const view = await updateMatrixView(createAdminClient(), user.id, viewId, input);
    return NextResponse.json({ view });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update matrix";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ viewId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { viewId } = await ctx.params;
  try {
    await deleteMatrixView(createAdminClient(), user.id, viewId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete matrix";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
