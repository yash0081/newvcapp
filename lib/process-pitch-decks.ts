import type { SupabaseClient } from "@supabase/supabase-js";
import { getGmailClient, getFullMessage, findPdfAttachments, getAttachment } from "@/lib/gmail";
import { runDealSourcingPipeline } from "@/lib/deal-sourcing-pipeline";

const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_PDF_BYTES = 50 * 1024; // 50 KB

export type ProcessPitchDecksConn = {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string | null;
};

export type ProcessPitchDecksResult = {
  processed: number;
  total: number;
  skippedNoPdf: number;
  skippedSize: number;
  skippedAlreadyScored: number;
  errors: string[];
  debug: { gmail_message_id: string; reason: string; detail?: string }[];
};

/**
 * Run pitch deck scoring for a Gmail connection. Used by both the API route
 * (POST /api/gmail/process-pitch-decks) and the webhook so the webhook doesn't
 * need to call the app over HTTP (which was causing ECONNRESET on Vercel).
 */
export async function processPitchDecksForConnection(
  admin: SupabaseClient,
  conn: ProcessPitchDecksConn,
  messageIdsFilter: string[] | null = null
): Promise<ProcessPitchDecksResult> {
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
      return {
        processed: 0,
        total: 0,
        skippedNoPdf: 0,
        skippedSize: 0,
        skippedAlreadyScored: 0,
        errors: [],
        debug: [],
      };
    }
    emails = list;
  } else {
    const { data: list, error: emailsError } = await admin
      .from("emails")
      .select("id, gmail_message_id")
      .eq("gmail_connection_id", conn.id)
      .is("deleted_at", null);
    if (emailsError || !list?.length) {
      return {
        processed: 0,
        total: 0,
        skippedNoPdf: 0,
        skippedSize: 0,
        skippedAlreadyScored: 0,
        errors: [],
        debug: [],
      };
    }
    emails = list;
  }

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
      const status =
        (err as { code?: number; response?: { status?: number } })?.code ??
        (err as { response?: { status?: number } })?.response?.status;
      const message = err instanceof Error ? err.message : String(err);
      const isAuthError =
        status === 401 ||
        status === 403 ||
        (status === 400 && /invalid_grant/i.test(message));

      if (isAuthError) {
        await admin.from("gmail_connections").delete().eq("id", conn.id);
        errors.push(
          `${email.gmail_message_id}: Gmail connection expired or revoked. Please reconnect your Gmail account.`
        );
        debug.push({
          gmail_message_id: email.gmail_message_id,
          reason: "auth_error",
          detail: message,
        });
        break;
      }

      errors.push(`${email.gmail_message_id}: ${message}`);
      debug.push({ gmail_message_id: email.gmail_message_id, reason: "error", detail: message });
    }
  }

  return {
    processed,
    total: emails.length,
    skippedNoPdf,
    skippedSize,
    skippedAlreadyScored,
    errors,
    debug,
  };
}
