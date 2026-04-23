import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DealIntelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/");
  }

  const { data: dealRows, error: dealErr } = await supabase.rpc("deal_intel_get_deal_metadata", {
    p_deal_id: id,
  });
  const deal = Array.isArray(dealRows) ? (dealRows[0] as { id: string; metadata: unknown } | undefined) : undefined;

  if (dealErr || !deal) {
    notFound();
  }

  const { data: nodes } = await supabase.rpc("deal_intel_get_fact_nodes_for_view", {
    p_deal_id: id,
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <Link
          href="/home/research"
          className="text-sm text-zinc-500 hover:text-zinc-800 underline underline-offset-2"
        >
          ← Back to research
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 mt-2">deal_intel deal</h1>
        <p className="text-sm text-zinc-500 font-mono mt-1 break-all">{deal.id as string}</p>
        <p className="text-xs text-zinc-400 mt-1">
          Created {"—"}
        </p>
      </div>

      <Card className="border-zinc-200/90">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-zinc-50 rounded-lg p-3 overflow-x-auto text-zinc-800">
            {JSON.stringify(deal.metadata ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <Card className="border-zinc-200/90">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">deal_fact_node ({(nodes ?? []).length} rows)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-zinc-500 mb-3">
            Flattened paths from the ingest JSON. Scalars in <code>value_text</code>; arrays of primitives
            and empty structures in <code>value_jsonb</code>.
          </p>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {(nodes ?? []).map((n: { path: string; value_text: string | null; value_jsonb: unknown }) => (
              <div
                key={n.path as string}
                className="text-xs border border-zinc-100 rounded-lg p-2 bg-zinc-50/80"
              >
                <div className="font-mono text-zinc-700">{(n.path as string) || "(root)"}</div>
                {n.value_text != null && n.value_text !== "" && (
                  <div className="text-zinc-800 mt-1 whitespace-pre-wrap">{(n.value_text as string).slice(0, 2000)}</div>
                )}
                {n.value_jsonb != null && (
                  <pre className="text-zinc-600 mt-1 overflow-x-auto text-[11px]">
                    {JSON.stringify(n.value_jsonb, null, 0).slice(0, 1500)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
