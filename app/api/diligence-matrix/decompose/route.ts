import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/research/db";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { question } = (await req.json().catch(() => ({}))) as { question?: string };
    if (!question || !question.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const trimmed = question.trim();

    const prompt = `You are an AI analyst that decomposes broad VC due diligence or company research questions into highly specific, measurable tabular matrix columns.
    
    A user has asked a question: "${trimmed}"
    
    If the question is narrow, specific, or already highly granular (e.g. "EBITDA margin", "Revenue growth YoY", "Beat/miss goals", "HQ city"), do NOT decompose it. Return the original question as the single item.
    
    If the question is broad or compound (e.g. "Founder background", "Market size and traction", "Financial performance", "Hiring and team"), decompose it into 2 to 4 distinct, concrete, highly specific columns.
    Each decomposed column must have:
    - label: Short 2-4 word column label (e.g. "Founder Degree" instead of "Tell me their degree")
    - dataType: "text" | "number" | "percent" | "currency" | "boolean"
    - prompt: A highly specific prompt instructions to find that exact data point.
    
    Return strict JSON only matching the schema:
    {
      "decomposed": [
        {
          "label": "Column label",
          "dataType": "text|number|percent|currency|boolean",
          "prompt": "Specific instructions..."
        }
      ]
    }
    `;

    const modelName = process.env.GEMINI_MODEL_FLASH_LITE || "gemini-2.5-flash-lite";
    const raw = await vertexRunWithText(modelName, prompt, false);
    const parsed = parseJsonFromResponseOrNull(raw) as {
      decomposed?: Array<{ label: string; dataType: string; prompt: string }>;
    } | null;

    if (!parsed || !Array.isArray(parsed.decomposed) || parsed.decomposed.length === 0) {
      // Fallback to original
      const originalLabel = trimmed.length > 48 ? `${trimmed.slice(0, 45).trim()}...` : trimmed;
      return NextResponse.json({
        columns: [
          {
            label: originalLabel,
            dataType: "text",
            prompt: trimmed,
          },
        ],
      });
    }

    // Map to columns
    const columns = parsed.decomposed.map((c) => {
      const label = (c.label || "").trim();
      const finalLabel = label.length > 48 ? `${label.slice(0, 45).trim()}...` : label;
      const t = c.dataType;
      const dataType =
        t === "text" || t === "number" || t === "percent" || t === "currency" || t === "boolean"
          ? t
          : "text";
      return {
        label: finalLabel,
        dataType,
        prompt: (c.prompt || "").trim() || trimmed,
      };
    });

    return NextResponse.json({ columns });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to decompose question";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
