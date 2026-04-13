"use client";

import { AgentChat } from "@/components/agent-chat";

export function DealChatPanel({ dealId, dealName }: { dealId: string; dealName: string }) {
  return <AgentChat dealId={dealId} dealName={dealName} variant="embedded" />;
}
