"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DisconnectGmailButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect your Gmail account? This will stop receiving new email notifications.")) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/gmail/disconnect", { method: "POST" });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json();
        alert(`Failed to disconnect: ${data.error || "Unknown error"}`);
      }
    } catch (err) {
      console.error("Disconnect failed:", err);
      alert("Failed to disconnect Gmail. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDisconnect}
      disabled={loading}
      className="px-4 py-2 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? "Disconnecting..." : "Disconnect Gmail"}
    </button>
  );
}
