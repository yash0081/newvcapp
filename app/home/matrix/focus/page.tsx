import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DiligenceMatrix } from "@/components/diligence-matrix/diligence-matrix";

export default async function MatrixFocusPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return <DiligenceMatrix focusMode />;
}
