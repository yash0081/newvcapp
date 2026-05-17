import { redirect } from "next/navigation";
import { WorkspaceChat } from "@/components/chat/workspace-chat";
import { listSavedChatThreads } from "@/lib/chat/history";
import { listChatDeals } from "@/lib/chat/workspace-chat";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export default async function CompanyChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ threadId?: string }>;
}) {
  const { id } = await params;
  const { threadId } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const [deals, threads] = await Promise.all([
    listChatDeals(admin, user.id).catch(() => []),
    listSavedChatThreads(admin, user.id, { dealId: id }).catch(() => []),
  ]);

  return <WorkspaceChat deals={deals} initialThreads={threads} initialDealId={id} initialThreadId={threadId ?? null} />;
}

