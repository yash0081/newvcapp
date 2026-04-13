"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, LayoutGrid } from "lucide-react";
import { DealsGridClient } from "@/components/deals-grid-client";

type SheetRow = {
  id: string;
  name: string;
  deal_ids: string[];
  updated_at?: string;
};

export function SpreadsheetWorkspace() {
  const router = useRouter();
  const search = useSearchParams();
  const activeSheetId = search.get("sheet");

  const [sheets, setSheets] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/spreadsheets");
    const data = await res.json().catch(() => ({}));
    const rows = (data as { spreadsheets?: SheetRow[] }).spreadsheets;
    if (res.ok && Array.isArray(rows)) setSheets(rows);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const activeDealIds = useMemo(() => {
    if (!activeSheetId) return null;
    const s = sheets.find((x) => x.id === activeSheetId);
    return s?.deal_ids?.length ? s.deal_ids : [];
  }, [activeSheetId, sheets]);

  async function newSheetFromSelected(dealIds: string[]) {
    const res = await fetch("/api/spreadsheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New spreadsheet", deal_ids: dealIds }),
    });
    const data = await res.json().catch(() => ({}));
    const id = (data as { spreadsheet?: { id?: string } }).spreadsheet?.id;
    await refresh();
    if (id) router.replace(`/home/deals/grid?sheet=${encodeURIComponent(id)}`);
  }

  return (
    <div className="flex flex-1 min-h-0 w-full bg-white">
      <aside className="hidden md:flex w-[288px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80">
        <div className="p-3 border-b border-zinc-200/90 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-zinc-800 tracking-tight">Spreadsheets</p>
            <Link
              href="/home/deals"
              className="text-[11px] text-zinc-500 hover:text-zinc-800 underline underline-offset-2"
            >
              Deals
            </Link>
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Create views by selecting deals in the grid, then saving.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {loading ? (
            <p className="text-xs text-zinc-500 px-2 py-3">Loading…</p>
          ) : sheets.length === 0 ? (
            <p className="text-xs text-zinc-500 px-2 py-3">No spreadsheets yet.</p>
          ) : (
            sheets.map((s) => {
              const active = activeSheetId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => router.push(`/home/deals/grid?sheet=${encodeURIComponent(s.id)}`)}
                  className={`w-full group flex items-center gap-2 rounded-xl px-2.5 py-2 text-left border ${
                    active
                      ? "border-zinc-300 bg-white shadow-sm"
                      : "border-transparent hover:bg-white/80 hover:border-zinc-200/80"
                  }`}
                >
                  <LayoutGrid className="h-4 w-4 text-zinc-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-900 truncate">{s.name || "Untitled"}</div>
                    <div className="text-[11px] text-zinc-500">
                      {(s.deal_ids?.length ?? 0).toString()} deal(s)
                    </div>
                  </div>
                </button>
              );
            })
          )}
          <button
            type="button"
            onClick={() => router.push("/home/deals/grid")}
            className={`w-full mt-2 text-xs rounded-full px-3 py-2 border ${
              !activeSheetId
                ? "border-zinc-300 bg-white shadow-sm text-zinc-900"
                : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-white"
            }`}
          >
            Show all deals
          </button>
        </div>

        <div className="p-3 border-t border-zinc-200/90">
          <button
            type="button"
            onClick={() => void newSheetFromSelected([])}
            className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-zinc-900 text-white text-sm font-medium py-2.5 px-3 hover:bg-zinc-800 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New spreadsheet
          </button>
          <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
            Tip: select deals in the grid, then “Save selected deals” to create a named view.
          </p>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-zinc-100">
        <div className="flex-1 min-h-0 p-3 md:p-5">
          <DealsGridClient externalFilterDealIds={activeDealIds} onCreateSheet={newSheetFromSelected} />
        </div>
      </div>
    </div>
  );
}

