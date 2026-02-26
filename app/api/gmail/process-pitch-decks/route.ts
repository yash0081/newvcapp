import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGmailClient, getFullMessage, findPdfAttachments, getAttachment } from "@/lib/gmail";
import { runDealSourcingPipeline } from "@/lib/deal-sourcing-pipeline";
import { NextRequest, NextResponse } from "next/server";

const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_PDF_BYTES = 50 * 1024; // 50 KB

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  let conn: { id: string; user_id: string; access_token: string; refresh_token: string | null } | null = null;

  // Internal call from webhook: secret + messageIds + emailAddress (no user session)
  const internalSecret = request.headers.get("x-internal-secret");
  const secret = process.env.INTERNAL_SECRET;
  let messageIdsFilter: string[] | null = null;
  if (secret && internalSecret === secret) {
    try {
      const body = await request.json().catch(() => ({}));
      const { messageIds, emailAddress } = body as { messageIds?: string[]; emailAddress?: string };
      if (Array.isArray(messageIds) && messageIds.length && typeof emailAddress === "string") {
        const { data: connection, error: connError } = await admin
          .from("gmail_connections")
          .select("id, user_id, access_token, refresh_token")
          .eq("email", emailAddress)
          .single();
        if (!connError && connection) {
          conn = connection;
          messageIdsFilter = messageIds;
        }
      }
    } catch {
      // ignore
    }
  }

  // Normal call: require user session
  if (!conn) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: connection, error: connError } = await admin
      .from("gmail_connections")
      .select("id, user_id, access_token, refresh_token")
      .eq("user_id", user.id)
      .single();
    if (connError || !connection) {
      return NextResponse.json(
        { error: "No Gmail connection" },
        { status: 400 }
      );
    }
    conn = connection;
  }

  // Load fund thesis for this user (for Phase 2 thesis-fit scoring)
  let fundThesisStatement: string | null = null;
  const { data: thesisRow } = await admin
    .from("fund_thesis")
    .select("thesis_text")
    .eq("user_id", conn.user_id)
    .maybeSingle();
  if (thesisRow && typeof (thesisRow as { thesis_text?: string }).thesis_text === "string") {
    fundThesisStatement = (thesisRow as { thesis_text: string }).thesis_text;
  }

  const maxBytes = Number(process.env.PITCH_DECK_PDF_MAX_BYTES) || DEFAULT_MAX_PDF_BYTES;
  const gmail = getGmailClient(conn.access_token, conn.refresh_token ?? null);

  let emails: { id: string; gmail_message_id: string }[];
  if (messageIdsFilter?.length) {
    const { data: list, error: emailsError } = await admin
      .from("emails")
      .select("id, gmail_message_id")
      .eq("gmail_connection_id", conn.id)
      .is("deleted_at", null)
      .in("gmail_message_id", messageIdsFilter);
    if (emailsError || !list?.length) {
      return NextResponse.json({ processed: 0, total: 0, message: "No matching emails to process" });
    }
    emails = list;
  } else {
    const { data: list, error: emailsError } = await admin
      .from("emails")
      .select("id, gmail_message_id")
      .eq("gmail_connection_id", conn.id)
      .is("deleted_at", null);
    if (emailsError || !list?.length) {
      return NextResponse.json({ processed: 0, message: "No emails to process" });
    }
    emails = list;
  }

  // Skip emails that already have a pitch deck result so we don't re-run
  // the Gemini pipeline on every page load / button click.
  const emailIds = emails.map((e) => e.id);
  const { data: existingResults } = await admin
    .from("pitch_deck_results")
    .select("email_id")
    .in("email_id", emailIds);
  const alreadyScored = new Set(
    (existingResults ?? []).map((r) => (r as { email_id: string }).email_id)
  );

  let processed = 0;
  let skippedNoPdf = 0;
  let skippedSize = 0;
  let skippedAlreadyScored = 0;
  const errors: string[] = [];
  const debug: { gmail_message_id: string; reason: string; detail?: string }[] = [];

  for (const email of emails) {
    try {
      if (alreadyScored.has(email.id)) {
        skippedAlreadyScored++;
        debug.push({ gmail_message_id: email.gmail_message_id, reason: "already_scored" });
        continue;
      }

      const msg = await getFullMessage(gmail, email.gmail_message_id);
      const payload = msg.payload;
      if (!payload) {
        skippedNoPdf++;
        debug.push({ gmail_message_id: email.gmail_message_id, reason: "no_payload" });
        continue;
      }

      const pdfs = findPdfAttachments(payload);
      if (pdfs.length === 0) {
        skippedNoPdf++;
        debug.push({ gmail_message_id: email.gmail_message_id, reason: "no_pdf" });
        continue;
      }

      const first = pdfs[0];
      const buffer = await getAttachment(gmail, email.gmail_message_id, first.attachmentId);
      if (buffer.length < MIN_PDF_BYTES || buffer.length > maxBytes) {
        skippedSize++;
        debug.push({
          gmail_message_id: email.gmail_message_id,
          reason: "size",
          detail: `${buffer.length} bytes (allowed ${MIN_PDF_BYTES}–${maxBytes})`,
        });
        continue;
      }

      const result = await runDealSourcingPipeline(buffer, fundThesisStatement);

      await admin
        .from("pitch_deck_results")
        .upsert(
          {
            email_id: email.id,
            gmail_message_id: email.gmail_message_id,
            gmail_attachment_id: first.attachmentId,
            pdf_size_bytes: buffer.length,
            parsing_json: result.parsing_json,
            thesis_fit_json: result.thesis_fit_json,
            founder_signal_json: result.founder_signal_json,
            traction_signal_json: result.traction_signal_json,
            problem_quality_3c_json: result.problem_quality_3c_json,
            solution_defensibility_json: result.solution_defensibility_json,
            market_power_json: result.market_power_json,
            core_assumption_json: result.core_assumption_json,
            thesis_fit_score: result.thesis_fit_score,
            founder_signal_score: result.founder_signal_score,
            traction_signal_score: result.traction_signal_score,
            problem_quality_score: result.problem_quality_score,
            solution_defensibility_score: result.solution_defensibility_score,
            market_power_score: result.market_power_score,
            composite_score: result.composite_score,
            processed_at: new Date().toISOString(),
          },
          { onConflict: "email_id" }
        );
      processed++;
      debug.push({ gmail_message_id: email.gmail_message_id, reason: "ok" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${email.gmail_message_id}: ${msg}`);
      debug.push({ gmail_message_id: email.gmail_message_id, reason: "error", detail: msg });
    }
  }

  return NextResponse.json({
    processed,
    total: emails.length,
    skippedNoPdf,
    skippedSize,
    skippedAlreadyScored,
    errors: errors.length ? errors.slice(0, 10) : undefined,
    debug: debug.slice(0, 20),
  });
}
