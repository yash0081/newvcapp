import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StartMeetingButton } from "@/components/live-assistant/start-meeting-button";

export default async function CompanyMeetPage(props: { params: Promise<{ id: string }> }) {
  const { id: dealId } = await props.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: deal } = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!deal) redirect("/home/deals");

  const meta =
    deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : ({} as Record<string, unknown>);
  const name = typeof meta.company_name === "string" ? meta.company_name : "Company";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Live meeting</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Start a LiveKit room for <span className="font-medium text-zinc-700">{name}</span> and share a guest link.
        </p>
      </div>

      <Card className="border-zinc-200/90 bg-white">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Start</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <StartMeetingButton dealId={dealId} />
          <p className="text-xs text-zinc-500">
            Guests won’t need an account. They’ll be prompted for mic consent in the browser.
          </p>
          <p className="text-xs text-zinc-500">
            After joining as host, enable the live assistant in-room to start transcript and assistant events.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

