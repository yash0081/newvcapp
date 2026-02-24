"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSync() {
    setLoading(true);
    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });
      if (res.ok) {
        router.refresh();
        // Kick off scoring in background (same as on page load)
        fetch("/api/gmail/process-pitch-decks", { method: "POST" }).catch(() => {});
      } else {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Sync failed");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleSync}
      disabled={loading}
      className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-50"
    >
      {loading ? "Syncing…" : "Sync now"}
    </button>
  );
}
