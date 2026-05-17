import { NextResponse } from "next/server";
import { assertOwnedDeal } from "@/lib/crm/collaborators";
import { listCompanyActivity } from "@/lib/crm/activity";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(_req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { dealId } = await params;
  const admin = createAdminClient();
  const deal = await assertOwnedDeal(admin, user.id, dealId);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const activity = await listCompanyActivity(admin, user.id, dealId);
  return NextResponse.json({ activity });
}

