"use client";

import Link from "next/link";

export function ConnectGmailButton() {
  return (
    <Link
      href="/api/gmail/connect"
      className="inline-flex items-center justify-center rounded-full border-2 border-blue-600 bg-white text-blue-600 text-lg px-8 py-5 font-bold hover:bg-blue-50 active:scale-95 transition-all duration-200 shadow-sm hover:shadow-md"
    >
      Connect Gmail
    </Link>
  );
}
