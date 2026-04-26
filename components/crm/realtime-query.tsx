"use client";

import { useState } from "react";

type Hit =
  | { kind: "claim"; id: string; score: number; quote: string }
  | { kind: "chunk"; id: string; score: number; text: string }
  | { kind: "tree_node"; id: string; score: number; raw_text: string | null };

export function RealtimeQuery(props: { dealId: string }) {
  const { dealId } = props;
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);

  async function run() {
    setErr(null);
    const t = q.trim();
    if (!t) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/crm/companies/${dealId}/realtime-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queryText: t, limit: 18 }),
      });
      const data = (await res.json().catch(() => ({}))) as { hits?: unknown; error?: string };
      if (!res.ok) throw new Error(data.error || "Query failed");
      const raw = Array.isArray(data.hits) ? data.hits : [];
      const parsed: Hit[] = [];
      for (const h of raw) {
        if (!h || typeof h !== "object") continue;
        const o = h as Record<string, unknown>;
        const kind = String(o.kind ?? "");
        const id = String(o.id ?? "");
        const score = typeof o.score === "number" ? o.score : Number(o.score ?? 0);
        if (!id) continue;
        if (kind === "claim") parsed.push({ kind: "claim", id, score, quote: String(o.quote ?? "") });
        else if (kind === "chunk") parsed.push({ kind: "chunk", id, score, text: String(o.text ?? "") });
        else if (kind === "tree_node") parsed.push({ kind: "tree_node", id, score, raw_text: (o.raw_text as string | null) ?? null });
      }
      setHits(parsed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about this company…"
          className="flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
        />
        <button
          onClick={run}
          disabled={loading}
          className="rounded-xl bg-zinc-900 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </div>
      {err && <div className="text-sm text-red-600">{err}</div>}
      {hits.length > 0 && (
        <div className="space-y-2 max-h-[45vh] overflow-y-auto">
          {hits.map((h, i) => (
            <div key={`${h.kind}-${h.id}-${i}`} className="rounded-xl border border-zinc-100 bg-zinc-50/80 p-2">
              <div className="text-xs text-zinc-600">
                {h.kind} • score {Number(h.score ?? 0).toFixed(3)}
              </div>
              <div className="text-sm text-zinc-900 mt-1 whitespace-pre-wrap">
                {h.kind === "claim"
                  ? h.quote
                  : h.kind === "chunk"
                    ? h.text
                    : h.raw_text ?? ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

