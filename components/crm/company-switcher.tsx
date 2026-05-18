"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Building2, Check, ChevronDown, Loader2, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type CompanyOption = {
  id: string;
  name: string;
  stageLabel: string;
};

function dealIntelPathForSwitch(pathname: string, nextDealId: string): string {
  const match = pathname.match(/^\/home\/deal-intel\/[^/]+(\/.*)?$/);
  const suffix = match?.[1] ?? "";
  return `/home/deal-intel/${nextDealId}${suffix}`;
}

function CompanyAvatar({ name, size = "md" }: { name: string; size?: "md" | "sm" }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl bg-zinc-900 font-bold text-white",
        size === "md" ? "h-8 w-8 text-xs shadow-sm shadow-zinc-900/20" : "h-8 w-8 text-xs shadow-sm shadow-zinc-900/20",
      )}
    >
      {initial}
    </div>
  );
}

export function CompanySwitcher({
  dealId,
  companyName,
  stageLabel,
  expanded,
}: {
  dealId: string;
  companyName: string;
  stageLabel: string;
  expanded: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch("/api/crm/companies")
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { companies?: CompanyOption[]; error?: string } | null;
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        if (!cancelled) setCompanies(json?.companies ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load companies");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (company) =>
        company.name.toLowerCase().includes(q) || company.stageLabel.toLowerCase().includes(q),
    );
  }, [companies, query]);

  function switchToCompany(nextId: string) {
    if (nextId === dealId) {
      setOpen(false);
      return;
    }
    setOpen(false);
    setQuery("");
    router.push(dealIntelPathForSwitch(pathname, nextId));
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group min-w-0 text-left transition-colors",
            expanded
              ? "flex flex-1 items-center gap-2 rounded-xl px-1 py-0.5 hover:bg-zinc-200/70"
              : "flex flex-col items-center gap-1 rounded-xl p-1 hover:bg-zinc-200/70",
          )}
          aria-label="Switch company"
        >
          <CompanyAvatar name={companyName} size={expanded ? "md" : "sm"} />
          {expanded ? (
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-xs font-bold tracking-wider text-zinc-950 uppercase">
                  {companyName}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-data-[state=open]:rotate-180 data-[state=open]:rotate-180" />
              </span>
              <span className="mt-0.5 block truncate text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                {stageLabel}
              </span>
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={expanded ? "bottom" : "right"}
        className="w-72 rounded-2xl border-zinc-200 bg-white p-0 shadow-lg"
      >
        <div className="border-b border-zinc-100 p-2">
          <DropdownMenuLabel className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
            Switch company
          </DropdownMenuLabel>
          <div className="relative mt-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search companies…"
              className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-8 pr-2 text-xs text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-300 focus:bg-white"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <p className="px-2 py-4 text-center text-xs text-red-600">{error}</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-zinc-500">No companies found</p>
          ) : (
            filtered.map((company) => (
              <DropdownMenuItem
                key={company.id}
                className="cursor-pointer rounded-xl px-2 py-2 focus:bg-zinc-100"
                onSelect={() => switchToCompany(company.id)}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <CompanyAvatar name={company.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-zinc-900">{company.name}</p>
                    <p className="truncate text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                      {company.stageLabel}
                    </p>
                  </div>
                  {company.id === dealId ? <Check className="h-4 w-4 shrink-0 text-zinc-900" /> : null}
                </div>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator className="bg-zinc-100" />
        <DropdownMenuItem asChild className="mx-1 mb-1 cursor-pointer rounded-xl">
          <Link href="/home/deals" className="flex items-center gap-2 text-xs font-semibold text-zinc-700">
            <Building2 className="h-4 w-4" />
            All companies
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
