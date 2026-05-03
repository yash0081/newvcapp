"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SignOutButton } from "@/components/sign-out-button";
import { cn } from "@/lib/utils";

const nav: Array<{ href?: string; label: string; action?: "copilot" }> = [
  { href: "/home/deals", label: "Companies" },
  { href: "/home/chat", label: "Chat" },
  { label: "Copilot", action: "copilot" },
  { href: "/home/workflows", label: "Workflows" },
  { href: "/home/matrix", label: "Matrix" },
  { href: "/home/document-generator", label: "Documents" },
  { href: "/home/research", label: "Thesis & criteria" },
];

function navActive(href: string, pathname: string): boolean {
  if (href === "/home/research") return pathname === "/home/research";
  if (href === "/home/chat") return pathname === "/home/chat";
  if (href === "/home/workflows") return pathname === "/home/workflows";
  if (href === "/home/matrix") return pathname === "/home/matrix" || pathname.startsWith("/home/matrix/");
  if (href === "/home/document-generator") return pathname === "/home/document-generator";
  if (href === "/home/deals") return pathname === "/home/deals" || pathname.startsWith("/home/deal/");
  return false;
}

type ChromeRuntime = {
  lastError?: { message?: string };
  sendMessage?: (
    extensionId: string,
    message: { type: "OPEN_COPILOT_UI" },
    callback: (response?: { ok?: boolean; error?: string }) => void,
  ) => void;
};

declare global {
  interface Window {
    chrome?: { runtime?: ChromeRuntime };
  }
}

const COPILOT_EXTENSION_ID = process.env.NEXT_PUBLIC_COPILOT_EXTENSION_ID || "";

export function HomeAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [openingCopilot, setOpeningCopilot] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const chatRoute = pathname === "/home/chat";
  const gridRoute = pathname === "/home/deals/grid";
  const matrixRoute = pathname === "/home/matrix" || pathname.startsWith("/home/matrix/");
  const researchRoute = pathname === "/home/research";
  const compactContent =
    pathname === "/home/deals" ||
    pathname.startsWith("/home/deal/") ||
    pathname.startsWith("/home/deal-intel/") ||
    pathname === "/home/document-generator" ||
    pathname === "/home/workflows" ||
    pathname === "/home/deals/grid";
  const framedMaxWidth = chatRoute ? "max-w-[1680px]" : "max-w-[1180px]";
  const contentMaxWidth = researchRoute
    ? "max-w-5xl"
    : compactContent
      ? "max-w-[1120px]"
      : "max-w-4xl";

  function openCopilot() {
    setCopilotError(null);
    if (!COPILOT_EXTENSION_ID) {
      setCopilotError("Copilot extension id is not configured. Set NEXT_PUBLIC_COPILOT_EXTENSION_ID, restart the web app, then reload this page.");
      return;
    }
    const sendMessage = window.chrome?.runtime?.sendMessage;
    if (!sendMessage) {
      setCopilotError("Open the VCApp copilot extension from Chrome's toolbar.");
      return;
    }
    setOpeningCopilot(true);
    sendMessage(COPILOT_EXTENSION_ID, { type: "OPEN_COPILOT_UI" }, (response) => {
      const lastError = window.chrome?.runtime?.lastError?.message;
      setOpeningCopilot(false);
      if (lastError) {
        setCopilotError(`Could not open Copilot: ${lastError}`);
        return;
      }
      if (response?.ok === false) {
        setCopilotError(response.error || "Could not open Copilot.");
      }
    });
  }

  return (
    <div className="flex h-svh min-h-0 flex-col bg-zinc-100 text-zinc-900">
      <header className="z-10 shrink-0 border-b border-zinc-200/80 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-4 px-3 py-3 md:px-5">
          <Link
            href="/home/deals"
            className="flex h-9 shrink-0 items-center rounded-full border border-zinc-200 bg-white px-4 text-[13px] font-semibold tracking-tight text-zinc-950 shadow-sm"
          >
            Workroom
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {nav.map((item) => {
              if (item.action === "copilot") {
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={openCopilot}
                    disabled={openingCopilot}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 disabled:cursor-wait disabled:opacity-70 md:text-sm"
                  >
                    {openingCopilot ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {item.label}
                  </button>
                );
              }
              if (!item.href) return null;
              const active = navActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "shrink-0 rounded-full px-3.5 py-2 text-xs font-medium transition-colors md:text-sm",
                    active
                      ? "bg-zinc-900 text-white shadow-sm"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <SignOutButton className="hidden shrink-0 rounded-full px-3 py-2 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 sm:block" />
        </div>
        {copilotError ? (
          <div className="border-t border-zinc-200 bg-zinc-50 px-5 py-2 text-xs text-zinc-700">
            {copilotError}
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <main
          className={
            chatRoute
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : matrixRoute
                ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                : "min-h-0 flex-1 overflow-y-auto p-3 md:p-4"
          }
        >
          {chatRoute || gridRoute || matrixRoute ? (
            <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden border-zinc-200 bg-white shadow-sm md:rounded-b-2xl md:border-x md:border-b", framedMaxWidth)}>
              {children}
            </div>
          ) : (
            <div
              className={cn(
                "mx-auto w-full space-y-5",
                contentMaxWidth
              )}
            >
              {children}
            </div>
          )}
        </main>
        <div className="shrink-0 border-t border-zinc-200 bg-white px-4 py-2 sm:hidden">
          <SignOutButton className="w-full py-2 text-left text-xs text-zinc-600" />
        </div>
      </div>
    </div>
  );
}
