"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes — balances UX with server/DB cost

/**
 * When Gmail is connected, periodically refresh the server-rendered email list
 * so new mail (delivered via webhook) appears without the user reloading.
 */
export function EmailListRefresh() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
