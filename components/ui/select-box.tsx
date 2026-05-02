"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type OptionItem = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

type SelectBoxProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "children"> & {
  children: React.ReactNode;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  placeholder?: React.ReactNode;
  wrapperClassName?: string;
};

function optionItems(children: React.ReactNode): OptionItem[] {
  const out: OptionItem[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>(child)) return;
    const props = child.props;
    const value = props.value == null ? String(props.children ?? "") : String(props.value);
    out.push({
      value,
      label: props.children,
      disabled: Boolean(props.disabled),
    });
  });
  return out;
}

function changeEvent(value: string): React.ChangeEvent<HTMLSelectElement> {
  return {
    target: { value },
    currentTarget: { value },
  } as React.ChangeEvent<HTMLSelectElement>;
}

export function SelectBox({
  className,
  wrapperClassName,
  children,
  value,
  defaultValue,
  onChange,
  name,
  disabled,
  placeholder,
}: SelectBoxProps) {
  const options = optionItems(children);
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = React.useState<string>(
    defaultValue == null ? String(options[0]?.value ?? "") : String(defaultValue),
  );
  const selectedValue = controlled ? String(value ?? "") : internalValue;
  const selected = options.find((option) => option.value === selectedValue);
  const display = selected?.label ?? placeholder ?? options[0]?.label ?? "Select";

  function setValue(next: string) {
    if (!controlled) setInternalValue(next);
    onChange?.(changeEvent(next));
  }

  return (
    <div className={cn("relative", wrapperClassName)}>
      {name ? <input type="hidden" name={name} value={selectedValue} readOnly /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-900 outline-none transition-colors hover:bg-zinc-50 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500",
              className,
            )}
            disabled={disabled}
          >
            <span className={cn("min-w-0 flex-1 truncate", !selected && "text-zinc-400")}>{display}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[--radix-popper-anchor-width] rounded-2xl border border-zinc-200 bg-white p-1 shadow-lg">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              disabled={option.disabled}
              onSelect={() => setValue(option.value)}
              className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm focus:bg-zinc-100"
            >
              <span className="min-w-0 truncate">{option.label}</span>
              {option.value === selectedValue ? <Check className="h-4 w-4 shrink-0 text-zinc-700" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
