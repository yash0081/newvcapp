import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { defaultStageKey, ensureCrmStages, slugifyStageKey } from "@/lib/crm/stages";

async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const stages = await ensureCrmStages(admin, user.id);
  return NextResponse.json({ stages });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { label?: string } | null;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "label is required" }, { status: 400 });

  const admin = createAdminClient();
  const stages = await ensureCrmStages(admin, user.id);
  const existing = new Set(stages.map((stage) => stage.key));
  const base = slugifyStageKey(label);
  let key = base;
  let n = 2;
  while (existing.has(key)) key = `${base}_${n++}`;
  const maxPosition = stages.reduce((max, stage) => Math.max(max, stage.position), -1);

  const { data, error } = await admin
    .schema("deal_intel")
    .from("crm_stage")
    .insert({ user_id: user.id, key, label, position: maxPosition + 1 })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ stage: data });
}

export async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: string; label?: string; position?: number } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (typeof body?.label === "string" && body.label.trim()) patch.label = body.label.trim();
  if (Number.isFinite(body?.position)) patch.position = body?.position;
  if (!Object.keys(patch).length) return NextResponse.json({ error: "No changes provided" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("deal_intel")
    .from("crm_stage")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ stage: data });
}

export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createAdminClient();
  const stages = await ensureCrmStages(admin, user.id);
  const stage = stages.find((item) => item.id === id);
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (stage.is_default) return NextResponse.json({ error: "Default stage cannot be deleted" }, { status: 400 });
  const fallback = defaultStageKey(stages);

  const { data: deals, error: loadError } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("user_id", user.id);
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const moves = (deals ?? []).filter((deal: { metadata: unknown }) => {
    const meta = deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : {};
    return meta.crm_stage === stage.key;
  });
  await Promise.all(
    moves.map((deal: { id: string; metadata: unknown }) => {
      const meta = deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : {};
      return admin
        .schema("deal_intel")
        .from("deal")
        .update({ metadata: { ...meta, crm_stage: fallback } })
        .eq("id", deal.id)
        .eq("user_id", user.id);
    }),
  );

  const { error } = await admin.schema("deal_intel").from("crm_stage").delete().eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, moved: moves.length, fallback });
}

