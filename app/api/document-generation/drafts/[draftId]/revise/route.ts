import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { reviseDocumentContent } from "@/lib/document-generation/generator";

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { instruction?: string } | null;
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim().slice(0, 8000) : "";
  if (!instruction) return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  const admin = createAdminClient();
  try {
    const result = await reviseDocumentContent({ admin, userId: user.id, draftId, instruction });
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
