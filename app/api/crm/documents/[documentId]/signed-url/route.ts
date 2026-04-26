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

  if (error) {
    console.error("deal_intel.document signed-url lookup:", error);
    return NextResponse.json({ error: error.message || "Failed to load document" }, { status: 500 });
  }
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const expiresIn = Math.max(60, Math.min(60 * 60, Number(process.env.CRM_DOCS_SIGNED_URL_TTL_SECONDS) || 15 * 60));
  const { data, error: signErr } = await admin.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, expiresIn);

  if (signErr || !data?.signedUrl) {
    console.error("storage signed url:", signErr);
    return NextResponse.json({ error: signErr?.message || "Failed to sign URL" }, { status: 500 });
  }

  return NextResponse.json({ documentId: doc.id, signedUrl: data.signedUrl, expiresInSeconds: expiresIn });
}

