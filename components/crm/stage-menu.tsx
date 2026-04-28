"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Stage = "screened" | "in_process" | "invested" | "passed";

function stageLabel(s: Stage): string {
  if (s === "screened") return "Screened";
  if (s === "in_process") return "In process";
  if (s === "invested") return "Invested";
  return "Passed";
}

function stageDotClass(s: Stage): string {
  if (s === "screened") return "bg-zinc-400";
  if (s === "in_process") return "bg-blue-500";
  if (s === "invested") return "bg-emerald-500";
  return "bg-rose-500";
}

function stageRowClass(active: boolean): string {
  return active ? "bg-zinc-100 text-zinc-900" : "text-zinc-800";
}

export function StageMenu(props: {
  dealId: string;
  current: Stage;
}) {
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState<Stage>(props.current);

  const setStage = async (s: Stage) => {
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
            className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 disabled:opacity-60"
          >
            <span className={`h-2 w-2 rounded-full ${stageDotClass(val)}`} />
            <span>{stageLabel(val)}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[--radix-popper-anchor-width] rounded-2xl border border-zinc-200 bg-white p-1 shadow-lg"
        >
          {(["screened", "in_process", "invested", "passed"] as Stage[]).map((s) => (
            <DropdownMenuItem
              key={s}
              onSelect={() => void setStage(s)}
              className={`rounded-xl px-3 py-2 text-sm focus:bg-zinc-100 ${stageRowClass(s === val)}`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${stageDotClass(s)}`} />
                <span>{stageLabel(s)}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

