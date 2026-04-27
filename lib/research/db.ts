import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function getAuthedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

export async function getDealForUser(dealId: string, userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  return { data, error };
}

export async function getWorkflowForUser(workflowId: string, userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  return { data, error };
}

