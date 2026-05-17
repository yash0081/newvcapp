import type { SupabaseClient } from "@supabase/supabase-js";

export type MatrixSavedView = {
  id: string;
  name: string;
  dealIds: string[];
  columnIds: string[];
  updatedAt: string;
};

type ViewRow = {
  id: string;
  name: string;
  deal_ids: string[] | null;
  column_ids: string[] | null;
  updated_at: string;
};

function rowToView(row: ViewRow): MatrixSavedView {
  return {
    id: row.id,
    name: row.name,
    dealIds: Array.isArray(row.deal_ids) ? row.deal_ids.map(String) : [],
    columnIds: Array.isArray(row.column_ids) ? row.column_ids.map(String) : [],
    updatedAt: row.updated_at,
  };
}

export async function listMatrixViews(admin: SupabaseClient, userId: string): Promise<MatrixSavedView[]> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_view")
    .select("id, name, deal_ids, column_ids, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(48);
  if (res.error) throw res.error;
  return ((res.data ?? []) as ViewRow[]).map(rowToView);
}

export async function createMatrixView(
  admin: SupabaseClient,
  userId: string,
  input: { name: string; dealIds: string[]; columnIds: string[] },
): Promise<MatrixSavedView> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_view")
    .insert({
      user_id: userId,
      name: input.name.trim() || "Untitled matrix",
      deal_ids: input.dealIds.slice(0, 25),
      column_ids: input.columnIds.slice(0, 40),
    })
    .select("id, name, deal_ids, column_ids, updated_at")
    .single();
  if (res.error) throw res.error;
  return rowToView(res.data as ViewRow);
}

export async function updateMatrixView(
  admin: SupabaseClient,
  userId: string,
  viewId: string,
  input: { name?: string; dealIds?: string[]; columnIds?: string[] },
): Promise<MatrixSavedView> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || "Untitled matrix";
  if (input.dealIds !== undefined) patch.deal_ids = input.dealIds.slice(0, 25);
  if (input.columnIds !== undefined) patch.column_ids = input.columnIds.slice(0, 40);
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_view")
    .update(patch)
    .eq("id", viewId)
    .eq("user_id", userId)
    .select("id, name, deal_ids, column_ids, updated_at")
    .single();
  if (res.error) throw res.error;
  return rowToView(res.data as ViewRow);
}

export async function deleteMatrixView(admin: SupabaseClient, userId: string, viewId: string): Promise<void> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_view")
    .delete()
    .eq("id", viewId)
    .eq("user_id", userId);
  if (res.error) throw res.error;
}
