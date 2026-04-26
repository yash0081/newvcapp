"use client";

import { useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { updateCompanyStageAction } from "@/app/home/deals/server-actions";
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
  action: typeof updateCompanyStageAction;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setStage = (s: Stage) => {
    if (inputRef.current) inputRef.current.value = s;
    formRef.current?.requestSubmit();
  };

  return (
    <form ref={formRef} action={props.action} className="shrink-0">
      <input type="hidden" name="deal_id" value={props.dealId} />
      <input ref={inputRef} type="hidden" name="crm_stage" value={props.current} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          >
            <span className={`h-2 w-2 rounded-full ${stageDotClass(props.current)}`} />
            <span>{stageLabel(props.current)}</span>
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
              onSelect={() => setStage(s)}
              className={`rounded-xl px-3 py-2 text-sm focus:bg-zinc-100 ${stageRowClass(s === props.current)}`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${stageDotClass(s)}`} />
                <span>{stageLabel(s)}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </form>
  );
}

