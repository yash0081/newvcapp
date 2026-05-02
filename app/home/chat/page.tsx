import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listChatDeals } from "@/lib/chat/workspace-chat";
import { listSavedChatThreads } from "@/lib/chat/history";
import { WorkspaceChat } from "@/components/chat/workspace-chat";

export default async function AssistantPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const deals = await listChatDeals(admin, user.id).catch((e) => {
    console.error("[chat-page] failed to load deals", e);
    return [];
  });
  const threads = await listSavedChatThreads(admin, user.id).catch((e) => {
    console.error("[chat-page] failed to load saved chats", e);
    return [];
  });

  return <WorkspaceChat deals={deals} initialThreads={threads} />;
}
