import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";

type DealRow = {
  id: string;
  metadata: Record<string, unknown> | null;
  updated_at: string | null;
  created_at: string | null;
};

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20)));

  const res = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata, updated_at, created_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (res.error) {
    return withCopilotCors(req, NextResponse.json({ error: res.error.message }, { status: 500 }));
  }

  const deals = (res.data ?? []).map((row) => {
    const r = row as DealRow;
    const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
    const company =
      (typeof meta.company_name === "string" && meta.company_name) ||
      (typeof meta.title === "string" && meta.title) ||
      "Untitled deal";
    return {
      id: r.id,
      company_name: company,
      updated_at: r.updated_at ?? r.created_at ?? new Date(0).toISOString(),
    };
  });

  return withCopilotCors(req, NextResponse.json({ deals }));
}
