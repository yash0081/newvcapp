import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { SpreadsheetWorkspace } from "@/components/spreadsheet-workspace";

export default async function DealsGridPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return (
    <SpreadsheetWorkspace />
  );
}
