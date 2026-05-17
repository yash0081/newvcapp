import type { SupabaseClient } from "@supabase/supabase-js";

export type CollaboratorRole = "owner" | "admin" | "editor" | "viewer";

export type DealCollaborator = {
  id: string;
  deal_id: string;
  user_id: string;
  role: CollaboratorRole;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const COLLABORATOR_ROLES: CollaboratorRole[] = ["owner", "admin", "editor", "viewer"];

export function asCollaboratorRole(value: unknown): CollaboratorRole {
  return COLLABORATOR_ROLES.includes(value as CollaboratorRole) ? (value as CollaboratorRole) : "owner";
}

export async function assertOwnedDeal(admin: SupabaseClient, userId: string, dealId: string) {
  const { data, error } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; metadata: unknown } | null;
}

export async function ensureOwnerCollaborator(admin: SupabaseClient, userId: string, dealId: string): Promise<DealCollaborator | null> {
  const deal = await assertOwnedDeal(admin, userId, dealId);
  if (!deal) return null;

  const { data, error } = await admin
    .schema("deal_intel")
    .from("deal_collaborator")
    .upsert(
      {
        deal_id: dealId,
        user_id: userId,
        role: "owner",
        created_by: userId,
      },
      { onConflict: "deal_id,user_id" },
    )
    .select("id, deal_id, user_id, role, created_by, created_at, updated_at")
    .single();
  if (error) throw error;
  return data as DealCollaborator;
}

