import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listChatDeals } from "@/lib/chat/workspace-chat";
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

  return <WorkspaceChat deals={deals} />;
}
