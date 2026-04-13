"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/sign-out-button";
import { cn } from "@/lib/utils";

const nav: { href: string; label: string }[] = [
  { href: "/home/chat", label: "Chat" },
  { href: "/home/deals", label: "Deals" },
  { href: "/home/deals/grid", label: "Spreadsheet" },
  { href: "/home/research", label: "Thesis & criteria" },
];

function navActive(href: string, pathname: string): boolean {
  if (href === "/home/chat") return pathname === "/home/chat";
  if (href === "/home/research") return pathname === "/home/research";
  if (href === "/home/deals/grid") return pathname === "/home/deals/grid";
  if (href === "/home/deals") return pathname === "/home/deals" || pathname.startsWith("/home/deal/");
  return false;
}

export function HomeAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const chatRoute = pathname === "/home/chat";
  const gridRoute = pathname === "/home/deals/grid";
  const wideContent =
    pathname.startsWith("/home/deal/") || pathname === "/home/deals/grid";

  return (
    <div className="flex h-svh min-h-0 flex-col bg-zinc-100 text-zinc-900">
      <header className="shrink-0 border-b border-zinc-200 bg-white z-10">
        <div className="flex items-center gap-3 px-3 md:px-5 py-2.5 md:py-3">
          <Link
            href="/home/chat"
            className="font-semibold tracking-tight text-zinc-900 text-[15px] shrink-0"
          >
            Workroom
          </Link>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto min-w-0">
            {nav.map((item) => {
              const active = navActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1.5 text-xs md:text-sm font-medium transition-colors",
                    active
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <SignOutButton className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 py-1.5 px-2 rounded-lg hover:bg-zinc-100 transition-colors hidden sm:block" />
        </div>
      </header>

      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        <main
          className={
            chatRoute
              ? "flex-1 flex flex-col min-h-0 overflow-hidden"
              : "flex-1 overflow-y-auto min-h-0 p-4 md:p-8"
          }
        >
          {chatRoute || gridRoute ? (
            <div className="flex flex-1 flex-col min-h-0 w-full max-w-[1600px] mx-auto bg-white md:rounded-b-2xl md:border-x md:border-b border-zinc-200/90 shadow-sm overflow-hidden">
              {children}
            </div>
          ) : (
            <div
              className={cn(
                "mx-auto w-full space-y-6",
                wideContent ? "max-w-5xl" : "max-w-3xl md:max-w-4xl"
              )}
            >
              {children}
            </div>
          )}
        </main>
        <div className="sm:hidden shrink-0 border-t border-zinc-200 bg-white px-4 py-2">
          <SignOutButton className="text-xs text-zinc-600 w-full text-left py-2" />
        </div>
      </div>
    </div>
  );
}
