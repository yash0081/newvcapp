import type { SupabaseClient } from "@supabase/supabase-js";
import { getGmailClient, getFullMessage, findPdfAttachments, getAttachment } from "@/lib/gmail";
import { runDealSourcingPipeline } from "@/lib/deal-sourcing-pipeline";
import { persistDealAnalysis } from "@/lib/persist-deal";

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

  let processed = 0;
  let skippedNoPdf = 0;
  let skippedSize = 0;
  let skippedAlreadyScored = 0;
  const errors: string[] = [];
  const debug: { gmail_message_id: string; reason: string; detail?: string }[] = [];

  for (const email of emails) {
    try {
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

      await persistDealAnalysis({
        admin,
        userId: conn.user_id,
        pdfUrl: null,
        result,
      });
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
