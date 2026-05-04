import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: doc, error } = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id, storage_bucket, storage_path")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message || "Failed to load document" }, { status: 500 });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error: signErr } = await admin.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, 15 * 60);
  if (signErr || !data?.signedUrl) {
    return NextResponse.json({ error: signErr?.message || "Failed to sign URL" }, { status: 500 });
  }

  return NextResponse.redirect(data.signedUrl);
}
