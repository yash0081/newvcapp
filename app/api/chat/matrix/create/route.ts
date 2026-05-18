import { NextResponse } from "next/server";
import { executeCreateMatrixFromProposal, type MatrixColumnSpec } from "@/lib/diligence-matrix/chat-matrix";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type CreateMatrixBody = {
  name?: unknown;
  dealIds?: unknown;
  dealNames?: unknown;
  columnTheme?: unknown;
  explicitColumns?: unknown;
};

function parseExplicitColumns(raw: unknown): MatrixColumnSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: MatrixColumnSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const col = item as Record<string, unknown>;
    const label = typeof col.label === "string" ? col.label.trim() : "";
    if (!label) continue;
    out.push({
      label: label.slice(0, 80),
      prompt: typeof col.prompt === "string" ? col.prompt.trim().slice(0, 2000) : undefined,
      dataType:
        col.dataType === "text" ||
        col.dataType === "number" ||
        col.dataType === "percent" ||
        col.dataType === "currency" ||
        col.dataType === "boolean"
          ? col.dataType
          : undefined,
    });
  }
  return out;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as CreateMatrixBody | null;
  const dealIds = Array.isArray(body?.dealIds)
    ? body.dealIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, 25)
    : [];
  const dealNames = Array.isArray(body?.dealNames)
    ? body.dealNames.filter((n): n is string => typeof n === "string" && Boolean(n.trim()))
    : [];
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const columnTheme = typeof body?.columnTheme === "string" ? body.columnTheme.trim() : null;
  const explicitColumns = parseExplicitColumns(body?.explicitColumns);

  if (!dealIds.length) {
    return NextResponse.json({ error: "dealIds is required" }, { status: 400 });
  }
  if (!columnTheme && !explicitColumns.length) {
    return NextResponse.json({ error: "columnTheme or explicitColumns is required" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const authorized = await admin
      .schema("deal_intel")
      .from("deal")
      .select("id")
      .eq("user_id", user.id)
      .in("id", dealIds);
    if (authorized.error) throw authorized.error;
    const allowed = new Set((authorized.data ?? []).map((row) => String(row.id)));
    const filteredIds = dealIds.filter((id) => allowed.has(id));
    if (!filteredIds.length) {
      return NextResponse.json({ error: "No authorized companies for this matrix" }, { status: 403 });
    }

    const filteredNames = filteredIds.map((id) => {
      const idx = dealIds.indexOf(id);
      return idx >= 0 && dealNames[idx] ? dealNames[idx]! : id.slice(0, 8);
    });
    const result = await executeCreateMatrixFromProposal(admin, user.id, {
      name,
      dealIds: filteredIds,
      dealNames: filteredNames,
      columnTheme,
      explicitColumns,
    });

    return NextResponse.json({
      view: result.view,
      href: result.href,
      columnCount: result.columnCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create matrix";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
