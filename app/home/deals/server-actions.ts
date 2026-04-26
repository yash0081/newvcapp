"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type Stage = "screened" | "in_process" | "invested" | "passed";

function asStage(v: unknown): Stage {
  const s = typeof v === "string" ? v : "";
  if (s === "screened" || s === "in_process" || s === "invested" || s === "passed") return s;
  return "screened";
}

export async function createCompanyAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const company_name = String(formData.get("company_name") ?? "").trim();
  const websiteRaw = String(formData.get("website") ?? "").trim();
  const website = websiteRaw.length ? websiteRaw : null;
  const crm_stage = asStage(formData.get("crm_stage"));
  if (!company_name) throw new Error("company_name is required");

  const { error } = await supabase.schema("deal_intel").from("deal").insert({
    user_id: user.id,
    metadata: { company_name, website, crm_stage, source: "crm" },
  });
  if (error) throw new Error(error.message);

  revalidatePath("/home/deals");
}

export async function updateCompanyStageAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const deal_id = String(formData.get("deal_id") ?? "").trim();
  const crm_stage = asStage(formData.get("crm_stage"));
  if (!deal_id) throw new Error("deal_id is required");

  const { data: existing, error: loadErr } = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", deal_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (loadErr) throw new Error(loadErr.message);
  if (!existing) throw new Error("Not found");

  const meta = (existing.metadata && typeof existing.metadata === "object" ? (existing.metadata as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;

  const { error } = await supabase
    .schema("deal_intel")
    .from("deal")
    .update({ metadata: { ...meta, crm_stage } })
    .eq("id", deal_id)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);

  revalidatePath("/home/deals");
  revalidatePath(`/home/deal-intel/${deal_id}`);
}

