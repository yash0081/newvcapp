import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMatrixColumn, type MatrixColumn } from "@/lib/diligence-matrix/matrix";
import { getAuthedUser } from "@/lib/research/db";

function asDataType(v: unknown): MatrixColumn["data_type"] {
  return v === "number" || v === "percent" || v === "currency" || v === "boolean" || v === "json" ? v : "text";
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { label?: unknown; description?: unknown; dataType?: unknown; prompt?: unknown; researchEnabled?: unknown }
    | null;
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 120) : "";
  if (!label) return NextResponse.json({ error: "label is required" }, { status: 400 });
  try {
    const column = await createMatrixColumn(createAdminClient(), user.id, {
      label,
      description: typeof body?.description === "string" ? body.description.trim().slice(0, 1200) : "",
      dataType: asDataType(body?.dataType),
      prompt: typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "",
      researchEnabled: body?.researchEnabled !== false,
    });
    return NextResponse.json({ column });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create column";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
