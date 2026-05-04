import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { createCustomWorkflowRun, formatUnknownError, loadCustomWorkflowDefinition, runCustomWorkflow } from "@/lib/custom-workflows";

export async function POST(req: Request, ctx: { params: Promise<{ workflowId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workflowId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { dealId?: string | null; input?: string; stream?: boolean } | null;
  const dealId = typeof body?.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : null;
  const input = typeof body?.input === "string" ? body.input.trim().slice(0, 4000) : "";
  const admin = createAdminClient();
  const wantsStream = body?.stream === true || req.headers.get("accept")?.includes("text/event-stream");

  if (wantsStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        const send = (event: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            closed = true;
          }
        };
        void (async () => {
          try {
            const workflow = await loadCustomWorkflowDefinition(admin, user.id, workflowId);
            if (!workflow) {
              send({ type: "error", error: "Workflow not found" });
              return;
            }
            const result = await runCustomWorkflow({
              admin,
              userId: user.id,
              workflow,
              dealId,
              input,
              progress: {
                onRunStart: (event) => send({ type: "run_start", ...event }),
                onStepStart: (event) => send({ type: "step_start", ...event }),
                onStepProgress: (event) => send({ type: "step_progress", ...event }),
                onStepComplete: (event) => send({ type: "step_complete", ...event }),
              },
            });
            send({ type: "complete", result });
          } catch (e) {
            const message = formatUnknownError(e, "Workflow run failed");
            send({ type: "error", error: message });
          } finally {
            if (!closed) {
              try {
                controller.close();
              } catch {
                // Client disconnected.
              }
            }
          }
        })();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  try {
    const workflow = await loadCustomWorkflowDefinition(admin, user.id, workflowId);
    if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    const run = await createCustomWorkflowRun({ admin, userId: user.id, workflow, dealId, input });
    void runCustomWorkflow({ admin, userId: user.id, workflow, dealId, input, runId: run.id }).catch(async (e) => {
      const message = formatUnknownError(e, "Workflow run failed");
      await admin
        .schema("deal_intel")
        .from("custom_workflow_run")
        .update({ status: "failed", summary: message, error_message: message })
        .eq("id", run.id)
        .eq("user_id", user.id);
    });
    return NextResponse.json({ run }, { status: 202 });
  } catch (e) {
    const message = formatUnknownError(e, "Workflow run failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
