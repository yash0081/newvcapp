"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { stageDotClass } from "@/lib/crm/stages";

function stageRowClass(active: boolean): string {
  return active ? "bg-zinc-100 text-zinc-900" : "text-zinc-800";
}

export function StageMenu(props: {
  dealId: string;
  current: string;
  stages: Array<{ key: string; label: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState(props.current);
  const selected = props.stages.find((stage) => stage.key === val) ?? props.stages[0] ?? { key: "screened", label: "Screened" };

  const setStage = async (s: string) => {
    if (busy) return;
    setBusy(true);
    setVal(s);
    try {
      await fetch("/api/crm/companies/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: props.dealId, crm_stage: s }),
      });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className="inline-flex h-8 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 disabled:opacity-60"
          >
            <span className={`h-2 w-2 rounded-full ${stageDotClass(val)}`} />
            <span>{selected.label}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[--radix-popper-anchor-width] rounded-2xl border border-zinc-200 bg-white p-1 shadow-lg"
        >
          {props.stages.map((s) => (
            <DropdownMenuItem
              key={s.key}
              onSelect={() => void setStage(s.key)}
              className={`rounded-xl px-3 py-2 text-sm focus:bg-zinc-100 ${stageRowClass(s.key === val)}`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${stageDotClass(s.key)}`} />
                <span>{s.label}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
