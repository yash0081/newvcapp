import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Delete a document from:
 * - Supabase Storage bucket (object)
 * - deal_intel.document row (cascades to pages/sentences/chunks/claims via FK)
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: doc, error: docErr } = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id, storage_bucket, storage_path")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (docErr) return NextResponse.json({ error: docErr.message || "Failed to load document" }, { status: 500 });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 1) Delete object from Storage
  const { error: rmErr } = await admin.storage.from(doc.storage_bucket).remove([doc.storage_path]);
  if (rmErr) {
    console.error("storage remove:", rmErr);
    return NextResponse.json({ error: rmErr.message || "Failed to delete storage object" }, { status: 500 });
  }

  // 2) Delete DB row (CASCADE deletes derived tables)
  const { error: delErr } = await admin.schema("deal_intel").from("document").delete().eq("id", documentId).eq("user_id", user.id);
  if (delErr) return NextResponse.json({ error: delErr.message || "Failed to delete document row" }, { status: 500 });

  return NextResponse.json({ documentId, deleted: true });
}

