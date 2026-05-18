import { NextResponse } from "next/server";
import { decomposeMatrixColumns } from "@/lib/diligence-matrix/chat-matrix";
import { getAuthedUser } from "@/lib/research/db";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { question } = (await req.json().catch(() => ({}))) as { question?: string };
    if (!question || !question.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const columns = await decomposeMatrixColumns(question.trim());
    return NextResponse.json({
      columns: columns.map((c) => ({
        label: c.label,
        dataType: c.dataType ?? "text",
        prompt: c.prompt ?? c.label,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to decompose question";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
