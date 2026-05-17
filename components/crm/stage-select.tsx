"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_STAGE_KEY, stageDotClass } from "@/lib/crm/stages";

export type CrmStageOption = { key: string; label: string };

/**
 * SaaS-style dropdown that writes into a hidden input inside the parent form.
 * Keeps menu width equal to trigger width using `w-[--radix-popper-anchor-width]`.
 */
export function StageSelect(props: { name: string; stages: CrmStageOption[]; defaultValue?: string; className?: string }) {
  const initial = useMemo(() => {
    const fallback = props.stages[0]?.key ?? DEFAULT_STAGE_KEY;
    return props.stages.some((stage) => stage.key === props.defaultValue) ? props.defaultValue! : fallback;
  }, [props.defaultValue, props.stages]);
  const [val, setVal] = useState(initial);
  const selected = props.stages.find((stage) => stage.key === val) ?? props.stages[0] ?? { key: DEFAULT_STAGE_KEY, label: "Screened" };

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
              <span>{selected.label}</span>
            </span>
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[--radix-popper-anchor-width] rounded-2xl border border-zinc-200 bg-white p-1 shadow-lg"
        >
          {props.stages.map((s) => (
            <DropdownMenuItem
              key={s.key}
              onSelect={() => setVal(s.key)}
              className="rounded-xl px-3 py-2 text-sm focus:bg-zinc-100"
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
