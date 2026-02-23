"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSync() {
    setLoading(true);
    try {
      const syncRes = await fetch("/api/gmail/sync", { method: "POST" });
      if (!syncRes.ok) {
        const d = await syncRes.json().catch(() => ({}));
        alert(d.error || "Sync failed");
        return;
      }
      router.refresh();

      // After sync, automatically run pitch deck scoring so new emails with PDFs get processed
      const processRes = await fetch("/api/gmail/process-pitch-decks", { method: "POST" });
      const processData = await processRes.json().catch(() => ({}));
      if (processRes.ok && (processData.processed > 0 || processData.skippedNoPdf !== undefined)) {
        router.refresh();
        if (processData.processed > 0) {
          const msg = processData.errors?.length
            ? `Processed ${processData.processed} pitch deck(s). Some errors: ${processData.errors.slice(0, 2).join("; ")}`
            : `Processed ${processData.processed} pitch deck(s).`;
          alert(msg);
        } else if (processData.skippedNoPdf === processData.total && processData.total > 0) {
          alert(`Synced ${processData.total} email(s). No emails had a PDF attachment (50 KB – 10 MB).`);
        } else if (processData.skippedSize > 0) {
          alert(`Synced. ${processData.processed} deck(s) scored; ${processData.skippedSize} skipped (PDF size).`);
        }
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
      {loading ? "Syncing & scoring…" : "Sync now"}
    </button>
  );
}
