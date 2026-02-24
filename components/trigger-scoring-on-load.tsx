"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * When the user lands on /home with Gmail connected, trigger pitch deck scoring once
 * in the background so new emails (from webhook) get scored without pressing any button.
 */
export function TriggerScoringOnLoad() {
  const router = useRouter();
  const triggered = useRef(false);

  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;
    fetch("/api/gmail/process-pitch-decks", { method: "POST" })
      .then(() => router.refresh())
      .catch(() => {});
  }, [router]);

  return null;
}
