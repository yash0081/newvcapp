"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ScorePitchDecksButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch("/api/gmail/process-pitch-decks", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        router.refresh();
        if (data.processed !== undefined) {
          if (data.processed > 0) {
            alert(`Processed ${data.processed} pitch deck(s).${data.errors?.length ? ` Some errors: ${data.errors[0]}` : ""}`);
          } else if (data.total === 0) {
            alert("No emails to process. Sync first to pull in emails.");
          } else {
            const parts = [];
            if (data.skippedAlreadyScored) parts.push(`${data.skippedAlreadyScored} already scored`);
            if (data.skippedNoPdf) parts.push(`${data.skippedNoPdf} had no PDF`);
            if (data.skippedSize) parts.push(`${data.skippedSize} wrong size (50 KB – 10 MB)`);
            let msg = `0 pitch decks processed. ${parts.join("; ")}.`;
            const first = data.debug?.[0];
            if (first?.reason && first.reason !== "ok") {
              msg += ` First email: ${first.reason}${first.detail ? ` (${first.detail})` : ""}.`;
            }
            alert(msg);
          }
        }
      } else {
        alert(data.error || "Failed to process pitch decks.");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to process pitch decks.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
    >
      {loading ? "Processing…" : "Score pitch decks"}
    </button>
  );
}
