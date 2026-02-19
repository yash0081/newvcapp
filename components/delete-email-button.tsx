"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteEmailButton({ emailId }: { emailId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    setLoading(true);
    try {
      const res = await fetch(`/api/gmail/emails/${emailId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json();
        alert(`Failed to delete email: ${data.error || "Unknown error"}`);
      }
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Failed to delete email. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="px-3 py-1 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      title="Delete email"
    >
      {loading ? "..." : "×"}
    </button>
  );
}
