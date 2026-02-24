import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function getOAuth2Client(redirectUri: string) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

export function getAuthUrl(redirectUri: string, state?: string) {
  const oauth2 = getOAuth2Client(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force refresh token
    state: state ?? undefined,
  });
}

export async function getTokensFromCode(code: string, redirectUri: string) {
  const oauth2 = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

export function getGmailClient(accessToken: string, refreshToken: string | null) {
  const oauth2 = getOAuth2Client(
    process.env.GOOGLE_GMAIL_REDIRECT_URI ?? ""
  );
  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken ?? undefined,
  });
  return google.gmail({ version: "v1", auth: oauth2 });
}

export async function watchMailbox(
  client: gmail_v1.Gmail,
  topicName: string
): Promise<{ historyId: string; expiration: string }> {
  const res = await client.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });
  return {
    historyId: String(res.data.historyId ?? ""),
    expiration: String(res.data.expiration ?? ""),
  };
}

export async function stopWatchMailbox(
  client: gmail_v1.Gmail
): Promise<void> {
  await client.users.stop({
    userId: "me",
  });
}

export interface EmailMetadata {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export async function fetchNewEmails(
  client: gmail_v1.Gmail,
  startHistoryId: string
): Promise<{ emails: EmailMetadata[]; newHistoryId: string }> {
  const historyRes = await client.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
  });

  const messageIds = new Set<string>();
  for (const record of historyRes.data.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      if (added.message?.id) {
        messageIds.add(added.message.id);
      }
    }
  }

  const emails: EmailMetadata[] = [];
  for (const id of messageIds) {
    try {
      const msgRes = await client.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });
      const msg = msgRes.data;
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value ?? "";
      emails.push({
        id: msg.id!,
        subject: getHeader("Subject"),
        from: getHeader("From"),
        date: getHeader("Date"),
        snippet: msg.snippet ?? "",
      });
    } catch (err: unknown) {
      // Skip messages that 404 (deleted, trashed, or moved)
      const status = (err as { code?: number; response?: { status?: number } })?.code
        ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) continue;
      throw err;
    }
  }

  const newHistoryId = String(historyRes.data.historyId ?? startHistoryId);
  return { emails, newHistoryId };
}

export interface PdfAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
}

/**
 * Find PDF attachment parts (including nested). Accept:
 * - mimeType application/pdf (case-insensitive) with attachmentId, or
 * - filename ending in .pdf with attachmentId (some servers send wrong MIME).
 */
export function findPdfAttachments(payload: gmail_v1.Schema$MessagePart): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  function walk(part: gmail_v1.Schema$MessagePart) {
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = (part.filename ?? "").toLowerCase();
    const isPdf =
      part.body?.attachmentId &&
      (mime === "application/pdf" || filename.endsWith(".pdf"));
    if (isPdf && part.body?.attachmentId) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename ?? "attachment.pdf",
        mimeType: part.mimeType ?? "application/pdf",
      });
      return;
    }
    for (const p of part.parts ?? []) {
      walk(p);
    }
  }
  walk(payload);
  return out;
}

/**
 * Fetch full message (use for process-pitch-decks only).
 */
export async function getFullMessage(
  client: gmail_v1.Gmail,
  messageId: string
): Promise<gmail_v1.Schema$Message> {
  const res = await client.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return res.data;
}

/**
 * Fetch attachment bytes by messageId and attachmentId. Returns Buffer.
 */
export async function getAttachment(
  client: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const res = await client.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  const data = res.data.data;
  if (!data) throw new Error("Empty attachment data");
  return Buffer.from(data, "base64url");
}
