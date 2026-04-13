import { vertexRunWithText, vertexStreamText } from "@/lib/vertex";

function isBadAnswer(text: string): boolean {
  const t = text.trim();
  return t.length < 28 || /^i cannot|^i'm unable|^as an ai|^error:/i.test(t);
}

/**
 * Plan B6: max one reflection retry if the first answer is empty or clearly insufficient.
 */
export async function generateChatAnswerWithRetry(
  model: string,
  systemAndUserPrompt: string
): Promise<string> {
  let text = await vertexRunWithText(model, systemAndUserPrompt, false);
  if (!isBadAnswer(text)) return text;

  const repair = `${systemAndUserPrompt}\n\n---\nThe previous model reply was too short or refused. Produce a substantive answer using only the provided context. If context is missing, say exactly what is missing. Minimum 3 sentences.`;
  text = await vertexRunWithText(model, repair, false);
  return text;
}

export type StreamChatChunk =
  | { kind: "delta"; text: string }
  | { kind: "repaired"; text: string };

/**
 * Stream first pass from Vertex; if the aggregate reply is bad, emit a single repaired full text
 * (client should replace the assistant bubble).
 */
export async function* streamChatAnswerWithRetry(
  model: string,
  systemAndUserPrompt: string
): AsyncGenerator<StreamChatChunk, void, unknown> {
  let acc = "";
  for await (const chunk of vertexStreamText(model, systemAndUserPrompt, false)) {
    acc += chunk;
    yield { kind: "delta", text: chunk };
  }
  if (!isBadAnswer(acc)) return;

  const repair = `${systemAndUserPrompt}\n\n---\nThe previous model reply was too short or refused. Produce a substantive answer using only the provided context. If context is missing, say exactly what is missing. Minimum 3 sentences.`;
  const fixed = await vertexRunWithText(model, repair, false);
  yield { kind: "repaired", text: fixed };
}
