import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { loadDocumentType, preflightDocument } from "@/lib/document-generation/generator";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { dealId?: string | null; typeId?: string; prompt?: string }
    | null;
  const typeId = typeof body?.typeId === "string" ? body.typeId : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 8000) : "";
  if (!typeId || !prompt) return NextResponse.json({ error: "typeId and prompt are required" }, { status: 400 });
  const admin = createAdminClient();
  const type = await loadDocumentType(admin, user.id, typeId);
  if (!type) return NextResponse.json({ error: "Document type not found" }, { status: 404 });
  const preflight = await preflightDocument({
    admin,
    userId: user.id,
    dealId: typeof body?.dealId === "string" ? body.dealId : null,
    type,
    prompt,
  });
  return NextResponse.json({ preflight });
}
