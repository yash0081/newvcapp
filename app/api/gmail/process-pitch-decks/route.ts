import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGmailClient, getFullMessage, findPdfAttachments, getAttachment } from "@/lib/gmail";
import { runPitchDeckPipeline } from "@/lib/pipeline";
import { NextResponse } from "next/server";

const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_PDF_BYTES = 50 * 1024; // 50 KB

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: conn, error: connError } = await admin
    .from("gmail_connections")
    .select("id, access_token, refresh_token")
    .eq("user_id", user.id)
    .single();

  if (connError || !conn) {
    return NextResponse.json(
      { error: "No Gmail connection" },
      { status: 400 }
    );
  }

  const maxBytes = Number(process.env.PITCH_DECK_PDF_MAX_BYTES) || DEFAULT_MAX_PDF_BYTES;
  const gmail = getGmailClient(conn.access_token, conn.refresh_token ?? null);

  // Emails for this connection (non-deleted)
  const { data: emails, error: emailsError } = await admin
    .from("emails")
    .select("id, gmail_message_id")
    .eq("gmail_connection_id", conn.id)
    .is("deleted_at", null);

  if (emailsError || !emails?.length) {
    return NextResponse.json({ processed: 0, message: "No emails to process" });
  }

  let processed = 0;
  const errors: string[] = [];

  for (const email of emails) {
    try {
      const msg = await getFullMessage(gmail, email.gmail_message_id);
      const payload = msg.payload;
      if (!payload) continue;

      const pdfs = findPdfAttachments(payload);
      if (pdfs.length === 0) continue;

      const first = pdfs[0];
      const buffer = await getAttachment(gmail, email.gmail_message_id, first.attachmentId);
      if (buffer.length < MIN_PDF_BYTES || buffer.length > maxBytes) continue;

      const result = await runPitchDeckPipeline(buffer);

      await admin
        .from("pitch_deck_results")
        .upsert(
          {
            email_id: email.id,
            gmail_message_id: email.gmail_message_id,
            gmail_attachment_id: first.attachmentId,
            pdf_size_bytes: buffer.length,
            parsing_json: result.parsing_json,
            problem_extraction_json: result.problem_extraction_json,
            solution_extraction_json: result.solution_extraction_json,
            problem_quality_score: result.problem_quality_score,
            solution_quality_score: result.solution_quality_score,
            founder_team_quality_score: result.founder_team_quality_score,
            metrics_quality_score: result.metrics_quality_score,
            composite_score: result.composite_score,
            problem_web_json: result.problem_web_json,
            solution_web_json: result.solution_web_json,
            founder_web_json: result.founder_web_json,
            metrics_web_json: result.metrics_web_json,
            processed_at: new Date().toISOString(),
          },
          { onConflict: "email_id" }
        );
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${email.gmail_message_id}: ${msg}`);
    }
  }

  return NextResponse.json({
    processed,
    total: emails.length,
    errors: errors.length ? errors.slice(0, 10) : undefined,
  });
}
