import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { asCollaboratorRole, ensureOwnerCollaborator } from "@/lib/crm/collaborators";

async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET(_req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { dealId } = await params;
  const admin = createAdminClient();
  const collaborator = await ensureOwnerCollaborator(admin, user.id, dealId);
  if (!collaborator) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    collaborators: [{ ...collaborator, email: user.email ?? "You", name: user.email ?? "You" }],
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { dealId } = await params;
  const body = (await req.json().catch(() => null)) as { userId?: string; role?: string } | null;
  if (body?.userId && body.userId !== user.id) {
    return NextResponse.json({ error: "Only the current user can be added until org membership is connected." }, { status: 403 });
  }
  const admin = createAdminClient();
  const collaborator = await ensureOwnerCollaborator(admin, user.id, dealId);
  if (!collaborator) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const role = asCollaboratorRole(body?.role);
  const { data, error } = await admin
    .schema("deal_intel")
    .from("deal_collaborator")
    .update({ role })
    .eq("deal_id", dealId)
    .eq("user_id", user.id)
    .select("id, deal_id, user_id, role, created_by, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ collaborator: { ...data, email: user.email ?? "You", name: user.email ?? "You" } });
}

export async function DELETE() {
  return NextResponse.json({ error: "The owner collaborator cannot be removed in owner-only mode." }, { status: 400 });
}

