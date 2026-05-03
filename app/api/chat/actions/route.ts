import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  applyWorkspaceChatRecordUpdates,
  type PlannedUpdate,
  type UpdateTarget,
} from "@/lib/chat/workspace-chat";

const UPDATE_TARGETS: UpdateTarget[] = [
  "deal.company_name",
  "deal.website",
  "deal.crm_stage",
  "makeup.general_description",
  "makeup.general_education_history",
  "makeup.general_work_background",
  "origin.general_description",
  "traction.revenue_data",
  "traction.customer_size_and_count",
  "traction.growth_trends_description",
  "traction.company_stage",
  "traction.product_stage",
  "problem.general_problem_description",
  "problem.urgency",
  "problem.current_cost_for_customers",
  "problem.tam",
  "problem.sam",
  "problem.som",
  "solution.general_description",
  "solution.cost_to_customer_to_buy_product",
  "solution.solution_price_for_company",
  "solution.price_per_customer_build_and_serve",
  "solution.novelty_or_uniqueness",
  "solution.defensibility",
  "solution.timeline_description",
  "negative.negative_aspects",
];

const STAGES = new Set(["screened", "in_process", "invested", "passed"]);

function parseUpdates(raw: unknown): PlannedUpdate[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedUpdate[] = [];
  for (const item of raw) {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const target = String(o.target ?? "") as UpdateTarget;
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (!UPDATE_TARGETS.includes(target) || !value) continue;
    if (target === "deal.crm_stage" && !STAGES.has(value)) continue;
    out.push({ target, value: value.slice(0, 1200) });
    if (out.length >= 5) break;
  }
  return out;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown; dealId?: unknown; updates?: unknown }
    | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (action !== "record_update") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  const updates = parseUpdates(body?.updates);
  if (!dealId || !updates.length) return NextResponse.json({ error: "dealId and updates are required" }, { status: 400 });

  try {
    const actions = await applyWorkspaceChatRecordUpdates({
      admin: createAdminClient(),
      userId: user.id,
      dealId,
      updates,
    });
    return NextResponse.json({ actions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Action failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
