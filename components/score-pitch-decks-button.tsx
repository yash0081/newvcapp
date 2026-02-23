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
          alert(`Processed ${data.processed} pitch deck(s).`);
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
