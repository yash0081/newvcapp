import { redirect } from "next/navigation";
import { CrmStageSettings } from "@/components/crm/crm-stage-settings";
import { ensureCrmStages } from "@/lib/crm/stages";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const stages = await ensureCrmStages(createAdminClient(), user.id);
  return <CrmStageSettings initialStages={stages} />;
}

