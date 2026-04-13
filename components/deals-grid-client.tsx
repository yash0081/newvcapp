"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Row = {
  id: string;
  company_name: string | null;
  sector: string | null;
  stage: string | null;
  decision: string | null;
  created_at: string | null;
  crm_stage: string | null;
  crm_next_step: string | null;
  snippets: {
    problem: string;
    solution: string;
    traction: string;
    team: string;
  };
  scores?: Record<string, number | null>;
};

export function DealsGridClient({
  externalFilterDealIds,
  onCreateSheet,
}: {
  externalFilterDealIds?: string[] | null;
  onCreateSheet?: (dealIds: string[]) => void | Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkQ, setBulkQ] = useState("");
  const [bulkOut, setBulkOut] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);
  const [colKey, setColKey] = useState("");
  const [colLabel, setColLabel] = useState("");
  const [colMsg, setColMsg] = useState("");
  const [computeMsg, setComputeMsg] = useState("");
  const [computeLoading, setComputeLoading] = useState(false);
  const [sheetHistory, setSheetHistory] = useState<{ id: string; name: string; deal_ids: string[] }[]>([]);
  const [sheetName, setSheetName] = useState("");
  const [sheetMsg, setSheetMsg] = useState("");
  const [filterDealIds, setFilterDealIds] = useState<string[] | null>(null);

  useEffect(() => {
    fetch("/api/spreadsheets")
      .then((r) => r.json())
      .then((d) => setSheetHistory((d.spreadsheets ?? []) as typeof sheetHistory))
      .catch(() => setSheetHistory([]));
  }, []);

  const visibleRows = useMemo(() => {
    const source = externalFilterDealIds ?? filterDealIds;
    if (!source || source.length === 0) return rows;
    const allow = new Set(source);
    return rows.filter((r) => allow.has(r.id));
  }, [rows, filterDealIds, externalFilterDealIds]);

  useEffect(() => {
    fetch("/api/deals/grid")
      .then((r) => r.json())
      .then((d) => {
        const raw = (d.rows ?? []) as Row[];
        setRows(
          raw.map((r) => ({
            ...r,
            snippets: r.snippets ?? {
              problem: "—",
              solution: "—",
              traction: "—",
              team: "—",
            },
          }))
        );
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function registerColumn() {
    const key = colKey.trim().toLowerCase().replace(/\s+/g, "_");
    const label = colLabel.trim();
    if (!key || !label) return;
    setColMsg("");
    try {
      const res = await fetch("/api/deals/grid/columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          label,
          data_type: "text",
          origin: "explicit_user",
          compute_tier: "expensive",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setColMsg((data as { error?: string }).error || "Failed");
        return;
      }
      setColMsg(
        "Column registered. Run pending LLM columns after you have pending rows for inferred columns."
      );
      setColKey("");
      setColLabel("");
    } catch {
      setColMsg("Request failed.");
    }
  }

  async function runPendingLlmColumns() {
    setComputeLoading(true);
    setComputeMsg("");
    try {
      const res = await fetch("/api/deals/grid/columns/compute-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDeals: 15 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setComputeMsg((data as { error?: string }).error || "Failed");
        return;
      }
      const d = data as { processed?: number; errors?: number };
      setComputeMsg(`Processed ${d.processed ?? 0}, errors ${d.errors ?? 0}.`);
    } catch {
      setComputeMsg("Request failed.");
    } finally {
      setComputeLoading(false);
    }
  }

  async function saveSpreadsheet() {
    const name = sheetName.trim() || "My spreadsheet";
    if (selected.size === 0) {
      setSheetMsg("Select at least one deal.");
      return;
    }
    setSheetMsg("");
    try {
      const res = await fetch("/api/spreadsheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, deal_ids: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSheetMsg((data as { error?: string }).error || "Failed to save.");
        return;
      }
      setSheetName("");
      setSheetMsg("Saved.");
      const list = await fetch("/api/spreadsheets").then((r) => r.json());
      setSheetHistory((list.spreadsheets ?? []) as typeof sheetHistory);
    } catch {
      setSheetMsg("Request failed.");
    }
  }

  async function runBulk() {
    if (selected.size === 0 || !bulkQ.trim()) return;
    setBulkLoading(true);
    setBulkOut("");
    try {
      const res = await fetch("/api/deals/grid/bulk-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealIds: [...selected], question: bulkQ }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBulkOut((data as { error?: string }).error || "Failed");
        return;
      }
      setBulkOut((data as { answer?: string }).answer ?? "");
    } finally {
      setBulkLoading(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-zinc-600">Loading deals…</p>;
  }

  const inputClass =
    "mt-1 block w-full h-10 rounded-2xl border border-zinc-200 bg-white px-4 text-sm text-zinc-900 placeholder:text-zinc-400 shadow-inner focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10";
  const btnPrimary =
    "inline-flex items-center justify-center h-10 rounded-full bg-zinc-900 px-4 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 disabled:opacity-45 transition-colors";
  const btnSecondary =
    "inline-flex items-center justify-center h-10 rounded-full border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 shadow-sm hover:bg-zinc-50 disabled:opacity-45 transition-colors";

  return (
    <div className="space-y-5 text-zinc-900">
      {!externalFilterDealIds && (
        <div className="rounded-2xl border border-zinc-200/90 bg-white shadow-sm p-4 md:p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Spreadsheet history</h3>
          <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
            Save a named view of selected deals. Open a saved view to filter the grid.
          </p>
        </div>
        {sheetHistory.length === 0 ? (
          <p className="text-xs text-zinc-500">No saved spreadsheets yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {sheetHistory.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setFilterDealIds(s.deal_ids?.length ? s.deal_ids : null)}
                  className="text-xs rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-zinc-800 hover:bg-white"
                >
                  {s.name}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => setFilterDealIds(null)}
                className="text-xs text-zinc-600 underline underline-offset-2"
              >
                Show all deals
              </button>
            </li>
          </ul>
        )}
        <div className="flex flex-col sm:flex-row flex-wrap gap-2 sm:items-end">
          <label className="text-xs font-medium text-zinc-700 sm:flex-1 min-w-[140px]">
            Name
            <input
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              className={inputClass}
              placeholder="e.g. Seed B2B — March"
            />
          </label>
          <button type="button" onClick={() => void saveSpreadsheet()} className={btnPrimary}>
            Save selected deals
          </button>
          {onCreateSheet && (
            <button
              type="button"
              onClick={() => void onCreateSheet([...selected])}
              disabled={selected.size === 0}
              className={btnSecondary}
            >
              Create as new spreadsheet
            </button>
          )}
        </div>
        {sheetMsg && <p className="text-xs text-zinc-700">{sheetMsg}</p>}
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200/90 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50/90 text-left text-xs font-medium text-zinc-600">
                <th className="px-3 py-2.5 w-10"></th>
                <th className="px-3 py-2.5">Company</th>
                <th className="px-3 py-2.5">Sector</th>
                <th className="px-3 py-2.5">Stage</th>
                <th className="px-3 py-2.5 min-w-[200px]">Problem</th>
                <th className="px-3 py-2.5 min-w-[200px]">Solution</th>
                <th className="px-3 py-2.5 min-w-[200px]">Traction</th>
                <th className="px-3 py-2.5 min-w-[200px]">Team</th>
                <th className="px-3 py-2.5">CRM stage</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-sm text-zinc-500">
                    No deals yet. Upload a deck from the Assistant or{" "}
                    <Link href="/home/research" className="text-zinc-800 font-medium underline underline-offset-2">
                      Decks &amp; thesis
                    </Link>
                    .
                  </td>
                </tr>
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-sm text-zinc-500">
                    No deals match this saved view. Use &ldquo;Show all deals&rdquo; or pick another spreadsheet.
                  </td>
                </tr>
              ) : (
                visibleRows.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 hover:bg-zinc-50/60">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        className="rounded border-zinc-300 text-zinc-900"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-zinc-900">
                      <Link
                        href={`/home/deal/${r.id}`}
                        className="text-blue-700 hover:underline"
                      >
                        {r.company_name || "(Untitled)"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-zinc-700">{r.sector ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-700">{r.stage ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-700 text-xs leading-snug max-w-[280px]">
                      {r.snippets.problem}
                    </td>
                    <td className="px-3 py-2 text-zinc-700 text-xs leading-snug max-w-[280px]">
                      {r.snippets.solution}
                    </td>
                    <td className="px-3 py-2 text-zinc-700 text-xs leading-snug max-w-[280px]">
                      {r.snippets.traction}
                    </td>
                    <td className="px-3 py-2 text-zinc-700 text-xs leading-snug max-w-[280px]">
                      {r.snippets.team}
                    </td>
                    <td className="px-3 py-2 text-zinc-700 max-w-[120px] truncate">
                      {r.crm_stage ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200/90 bg-white shadow-sm divide-y divide-zinc-100">
        <section className="p-4 md:p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Custom columns</h3>
            <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
              Register keys in{" "}
              <code className="text-[11px] bg-zinc-100 text-zinc-800 px-1.5 py-0.5 rounded border border-zinc-200/80">
                deal_feature_definitions
              </code>
              . LLM backfill runs in batch via the button below.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_auto] sm:items-end">
            <label className="text-xs font-medium text-zinc-700">
              Key
              <input
                value={colKey}
                onChange={(e) => setColKey(e.target.value)}
                className={inputClass}
                placeholder="e.g. fund_fit_note"
              />
            </label>
            <label className="text-xs font-medium text-zinc-700">
              Label
              <input
                value={colLabel}
                onChange={(e) => setColLabel(e.target.value)}
                className={inputClass}
                placeholder="Display name"
              />
            </label>
            <button type="button" onClick={registerColumn} className={btnPrimary}>
              Register column
            </button>
          </div>
          {colMsg && <p className="text-xs text-zinc-700">{colMsg}</p>}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
            <button
              type="button"
              onClick={runPendingLlmColumns}
              disabled={computeLoading}
              className={btnSecondary}
            >
              {computeLoading ? "Running…" : "Run pending LLM columns"}
            </button>
            <p className="text-xs text-zinc-600 leading-relaxed flex-1">
              Fills up to 15 pending cells for expensive{" "}
              <code className="text-[11px] bg-zinc-100 text-zinc-800 px-1 rounded border border-zinc-200/80">
                inferred_llm
              </code>{" "}
              columns.
            </p>
          </div>
          {computeMsg && <p className="text-xs text-zinc-700">{computeMsg}</p>}
        </section>

        <section className="p-4 md:p-5 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Bulk insights</h3>
            <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
              Select rows, ask one question — same hybrid node retrieval as the Assistant.
            </p>
          </div>
          <textarea
            value={bulkQ}
            onChange={(e) => setBulkQ(e.target.value)}
            rows={3}
            className="mt-0 block w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 shadow-inner focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            placeholder="e.g. Which of these has the strongest moat signal in the indexed data?"
          />
          <button
            type="button"
            onClick={runBulk}
            disabled={bulkLoading || selected.size === 0 || !bulkQ.trim()}
            className={btnPrimary}
          >
            {bulkLoading ? "Running…" : `Run on ${selected.size} deal(s)`}
          </button>
          {bulkOut && (
            <pre className="text-xs whitespace-pre-wrap text-zinc-800 bg-zinc-50 rounded-lg p-3 border border-zinc-200/80 max-h-80 overflow-y-auto leading-relaxed">
              {bulkOut}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}

