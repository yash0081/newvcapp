"use client";

import { useMemo, useState } from "react";
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

/**
 * SaaS-style dropdown that writes into a hidden input inside the parent form.
 * Keeps menu width equal to trigger width using `w-[--radix-popper-anchor-width]`.
 */
export function StageSelect(props: { name: string; defaultValue?: Stage; className?: string }) {
  const initial = useMemo(() => (props.defaultValue ?? "screened") as Stage, [props.defaultValue]);
  const [val, setVal] = useState<Stage>(initial);

  return (
    <div className={props.className}>
      <input type="hidden" name={props.name} value={val} readOnly />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="crm-input flex items-center justify-between gap-2"
          >
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${stageDotClass(val)}`} />
              <span>{stageLabel(val)}</span>
            </span>
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[--radix-popper-anchor-width] rounded-2xl border border-zinc-200 bg-white p-1 shadow-lg"
        >
          {(["screened", "in_process", "invested", "passed"] as Stage[]).map((s) => (
            <DropdownMenuItem
              key={s}
              onSelect={() => setVal(s)}
              className="rounded-xl px-3 py-2 text-sm focus:bg-zinc-100"
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

