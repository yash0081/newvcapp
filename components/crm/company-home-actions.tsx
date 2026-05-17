"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, MessageSquarePlus, Search, Table2 } from "lucide-react";

export function CompanyHomeActions({ dealId, companyName }: { dealId: string; companyName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function newChat() {
    setBusy("chat");
    try {
      const res = await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${companyName} chat`, dealId }),
      });
      const data = (await res.json().catch(() => ({}))) as { threadId?: string; id?: string };
      const threadId = data.threadId || data.id;
      router.push(`/home/deal-intel/${dealId}/chat${threadId ? `?threadId=${threadId}` : ""}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <button className="crm-button h-11 justify-center" type="button" onClick={newChat} disabled={busy === "chat"}>
        {busy === "chat" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
        New chat session
      </button>
      <button className="crm-button-secondary h-11 justify-center" type="button" onClick={() => router.push(`/home/deal-intel/${dealId}/research`)}>
        <Search className="h-4 w-4" />
        New research session
      </button>
      <button className="crm-button-secondary h-11 justify-center" type="button" onClick={() => router.push(`/home/deal-intel/${dealId}/tabular`)}>
        <Table2 className="h-4 w-4" />
        New tabular review
      </button>
    </div>
  );
}

