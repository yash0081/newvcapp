import { Suspense } from "react";
import { ChatWorkspace } from "@/components/chat-workspace";

export default function AssistantPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 p-8">
          Loading chat…
        </div>
      }
    >
      <ChatWorkspace />
    </Suspense>
  );
}
