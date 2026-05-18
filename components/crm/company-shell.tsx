"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  Home,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Search,
  Table2,
  Database,
  ChevronLeft,
  ChevronRight,
  Workflow,
  PenTool,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QuickDocumentSearch } from "@/components/crm/quick-document-search";
import { CompanySwitcher } from "@/components/crm/company-switcher";

const tabs = [
  { key: "home", label: "Home", icon: Home, href: (id: string) => `/home/deal-intel/${id}` },
  { key: "chat", label: "Chat", icon: MessageSquare, href: (id: string) => `/home/deal-intel/${id}/chat` },
  { key: "research", label: "Research", icon: Search, href: (id: string) => `/home/deal-intel/${id}/research` },
  { key: "workflows", label: "Workflows", icon: Workflow, href: (id: string) => `/home/deal-intel/${id}/workflows` },
  { key: "drafts", label: "Drafts", icon: PenTool, href: (id: string) => `/home/deal-intel/${id}/drafts` },
  { key: "tabular", label: "Tabular Review", icon: Table2, href: (id: string) => `/home/deal-intel/${id}/tabular` },
  { key: "database", label: "Database", icon: Database, href: (id: string) => `/home/deal-intel/${id}/documents` },
  { key: "documents", label: "Documents", icon: FileText, action: "toggle-docs" },
  { key: "meet", label: "Live Meeting", icon: Radio, href: (id: string) => `/home/deal-intel/${id}/meet` },
];

export function CompanyShell({
  dealId,
  companyName,
  stageLabel,
  children,
}: {
  dealId: string;
  companyName: string;
  stageLabel: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(true);
  const [docSearchOpen, setDocSearchOpen] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("company-nav-expanded");
    if (saved) setExpanded(saved === "true");
  }, []);

  function toggle() {
    setExpanded((value) => {
      window.localStorage.setItem("company-nav-expanded", String(!value));
      return !value;
    });
  }

  const isScrollLocked = pathname.endsWith("/chat") || pathname.endsWith("/tabular") || pathname.endsWith("/documents") || pathname.endsWith("/workflows") || pathname.endsWith("/research") || pathname.endsWith("/drafts");

  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* Primary Sidebar */}
      <aside
        className={cn(
          "relative flex shrink-0 flex-col border-r border-zinc-200/80 bg-gradient-to-b from-zinc-50 via-zinc-50/60 to-zinc-100/40 transition-all duration-300 ease-in-out z-20 h-full",
          expanded ? "w-56" : "w-16"
        )}
      >
        {/* Sidebar Header / Brand */}
        <div className="border-b border-zinc-200/80 p-3.5 flex flex-col gap-3 shrink-0">
          {expanded ? (
            /* When expanded: avatar, text and collapser button at the SAME level (side-by-side) */
            <div className="flex items-center justify-between gap-2.5 min-w-0">
              <CompanySwitcher
                dealId={dealId}
                companyName={companyName}
                stageLabel={stageLabel}
                expanded
              />
              <button
                type="button"
                onClick={toggle}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-550 hover:border-zinc-300 hover:text-zinc-950 shadow-sm transition-all active:scale-95"
                title="Collapse sidebar"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            /* When collapsed: collapser button is above the company letter avatar */
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={toggle}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-550 hover:border-zinc-300 hover:text-zinc-950 shadow-sm transition-all active:scale-95"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="h-3.5 w-3.5" />
              </button>
              <CompanySwitcher
                dealId={dealId}
                companyName={companyName}
                stageLabel={stageLabel}
                expanded={false}
              />
            </div>
          )}
        </div>

        {/* Navigation Items */}
        <nav className="flex flex-1 flex-col gap-1.5 p-3 min-h-0 overflow-y-auto">
          {tabs.map((tab) => {
            const isToggle = tab.action === "toggle-docs";
            const href = isToggle ? "#" : tab.href?.(dealId) || "#";
            const Icon = tab.icon;
            const active = isToggle ? docSearchOpen : pathname === href;

            const content = (
              <>
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-all duration-200",
                    active ? "scale-110 text-white" : "text-zinc-500 group-hover:scale-110 group-hover:text-zinc-900"
                  )}
                />
                {expanded && <span className="truncate">{tab.label}</span>}
              </>
            );

            const commonClasses = cn(
              "group flex h-10 items-center gap-3 rounded-xl px-3 text-xs font-semibold tracking-wide uppercase transition-all duration-200 select-none",
              active
                ? "bg-zinc-900 text-white shadow-md shadow-zinc-900/10"
                : "text-zinc-650 hover:bg-zinc-200/60 hover:text-zinc-950 active:scale-95",
              !expanded && "justify-center px-0"
            );

            if (isToggle) {
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setDocSearchOpen(!docSearchOpen)}
                  title={expanded ? undefined : tab.label}
                  className={commonClasses}
                >
                  {content}
                </button>
              );
            }

            return (
              <Link
                key={tab.key}
                href={href}
                title={expanded ? undefined : tab.label}
                className={commonClasses}
              >
                {content}
              </Link>
            );
          })}
        </nav>

      </aside>

      {/* Quick Documents Panel (Sliding Expandable Tab) */}
      <div
        className={cn(
          "relative flex border-r border-zinc-200 transition-all duration-300 ease-in-out overflow-hidden z-10 bg-white",
          docSearchOpen ? "w-72" : "w-0 border-r-0"
        )}
      >
        <QuickDocumentSearch dealId={dealId} onClose={() => setDocSearchOpen(false)} />
      </div>

      {/* Main Workspace Area */}
      <section
        className={cn(
          "min-w-0 flex-1 flex flex-col transition-all duration-300 ease-in-out bg-white",
          isScrollLocked ? "overflow-hidden p-0 h-full" : "overflow-y-auto p-4 md:p-5"
        )}
      >
        {children}
      </section>
    </div>
  );
}
