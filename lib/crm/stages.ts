import type { SupabaseClient } from "@supabase/supabase-js";

export type CrmStage = {
  id: string;
  user_id: string;
  key: string;
  label: string;
  position: number;
  is_default: boolean;
  is_system: boolean;
  created_at?: string;
  updated_at?: string;
};

export const DEFAULT_STAGE_KEY = "screened";

const DEFAULT_STAGES: Array<Pick<CrmStage, "key" | "label" | "position" | "is_default" | "is_system">> = [
  { key: "screened", label: "Screened", position: 0, is_default: true, is_system: true },
  { key: "in_process", label: "In process", position: 1, is_default: false, is_system: true },
  { key: "invested", label: "Invested", position: 2, is_default: false, is_system: true },
  { key: "passed", label: "Passed", position: 3, is_default: false, is_system: true },
];

export function slugifyStageKey(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return key || `stage_${Date.now()}`;
}

export function stageDotClass(key: string): string {
  if (key === "screened") return "bg-zinc-400";
  if (key === "in_process") return "bg-blue-500";
  if (key === "invested") return "bg-emerald-500";
  if (key === "passed") return "bg-rose-500";
  return "bg-violet-500";
}

export function stageAccentClass(key: string): string {
  if (key === "screened") return "border-zinc-200 bg-zinc-50";
  if (key === "in_process") return "border-blue-200 bg-blue-50";
  if (key === "invested") return "border-emerald-200 bg-emerald-50";
  if (key === "passed") return "border-rose-200 bg-rose-50";
  return "border-violet-200 bg-violet-50";
}

export async function ensureCrmStages(admin: SupabaseClient, userId: string): Promise<CrmStage[]> {
  const existing = await admin
    .schema("deal_intel")
    .from("crm_stage")
    .select("id, user_id, key, label, position, is_default, is_system, created_at, updated_at")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (existing.error) throw existing.error;
  const rows = (existing.data ?? []) as CrmStage[];
  if (rows.length) return rows;

  const inserted = await admin
    .schema("deal_intel")
    .from("crm_stage")
    .insert(DEFAULT_STAGES.map((stage) => ({ ...stage, user_id: userId })))
    .select("id, user_id, key, label, position, is_default, is_system, created_at, updated_at")
    .order("position", { ascending: true });
  if (inserted.error) throw inserted.error;
  return (inserted.data ?? []) as CrmStage[];
}

export function defaultStageKey(stages: CrmStage[]): string {
  return stages.find((stage) => stage.is_default)?.key ?? DEFAULT_STAGE_KEY;
}

export function normalizeStageKey(raw: unknown, stages: CrmStage[]): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value && stages.some((stage) => stage.key === value)) return value;
  return defaultStageKey(stages);
}
