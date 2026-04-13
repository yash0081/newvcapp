"use client";

import { useMemo, useState } from "react";

function parseMemoSections(text: string): { title: string; body: string }[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (/^SECTION:\s/im.test(trimmed)) {
    return trimmed.split(/\n(?=SECTION:\s)/i).map((chunk) => {
      const lines = chunk.trim().split("\n");
      const first = lines[0]?.trim() ?? "";
      const m = first.match(/^SECTION:\s*(.+)$/i);
      const title = m?.[1]?.trim() ?? "Memo";
      const body = lines.slice(1).join("\n").trim();
      return { title, body };
    });
  }

  if (/^##\s+/m.test(trimmed)) {
    return trimmed.split(/\n(?=##\s+)/).map((chunk) => {
      const lines = chunk.trim().split("\n");
      const first = lines[0]?.trim() ?? "";
      const m = first.match(/^##\s+(.+)$/);
      const title = m?.[1]?.trim() ?? "Memo";
      const body = lines.slice(1).join("\n").trim();
      return { title, body: body || first };
    });
  }

  return [{ title: "Investment memo", body: trimmed }];
}

export function DealMemoButton({ dealId }: { dealId: string }) {
  const [loading, setLoading] = useState(false);
  const [memo, setMemo] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setMemo(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/memo`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMemo((data as { error?: string }).error || "Failed");
        return;
      }
      setMemo((data as { memo?: string }).memo ?? "");
    } finally {
      setLoading(false);
    }
  }

  const sections = useMemo(() => (memo ? parseMemoSections(memo) : []), [memo]);

  return (
    <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">Investment memo draft</h3>
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="inline-flex items-center justify-center h-9 rounded-full bg-zinc-900 px-4 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 disabled:opacity-50 transition-colors"
        >
          {loading ? "Generating…" : "Generate"}
        </button>
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed">
        Sections: exec summary, overview, market &amp; problem, product, traction, team, risks, comps,
        thesis, recommendation — from stored analysis (no doc RAG).
      </p>
      {memo && sections.length > 0 && (
        <div className="max-h-96 overflow-y-auto space-y-5 bg-zinc-50 rounded-2xl p-4 border border-zinc-200/80 text-sm leading-relaxed">
          {sections.map((sec, i) => (
            <section key={`${i}-${sec.title}`} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{sec.title}</h4>
              <div className="text-zinc-800 whitespace-pre-wrap">{sec.body || "—"}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
