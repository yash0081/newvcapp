import "server-only";
import { GoogleAuth } from "google-auth-library";

/** Vertex text-embedding-004 outputs 768 dimensions. */
export const DEAL_EMBEDDING_DIMENSIONS = 768;

/**
 * Read env at call time — not at module load. Otherwise scripts that call `dotenv.config()`
 * after imports see `undefined` here (imports run before the script body).
 */
function embeddingEnv() {
  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    /** Regional endpoint; avoid `global` for :predict */
    location: process.env.VERTEX_EMBEDDING_LOCATION || "us-central1",
    model: process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004",
  };
}

const MAX_CHARS = 8000;
const DEFAULT_BATCH_SIZE = Number(process.env.VERTEX_EMBEDDING_BATCH_SIZE || 24);

let authClient: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!authClient) authClient = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return authClient;
}

/**
 * Embed a single text chunk via Vertex `publishers/google/models/{model}:predict`.
 */
export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v!;
}

/**
 * Embed multiple text chunks in a single Vertex predict call (batched).
 * Uses the `instances: [{content}, ...]` multi-instance request.
 */
export async function embedTexts(texts: string[], batchSize = DEFAULT_BATCH_SIZE): Promise<number[][]> {
  const { projectId, location, model } = embeddingEnv();
  if (!projectId) {
    throw new Error("GOOGLE_CLOUD_PROJECT is not set");
  }
  const inputs = (texts ?? []).map((t) => String(t || "").trim().slice(0, MAX_CHARS));
  if (inputs.length === 0) return [];
  if (inputs.some((t) => !t)) {
    throw new Error("embedTexts: empty text input");
  }
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("embedTexts: failed to get access token");
  }
  const host = `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;

  const out: number[][] = [];
  const bs = Math.max(1, Math.min(96, Math.floor(batchSize || DEFAULT_BATCH_SIZE)));
  for (let i = 0; i < inputs.length; i += bs) {
    const batch = inputs.slice(i, i + bs);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: batch.map((content) => ({ content })),
        parameters: { autoTruncate: true },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vertex embedding failed ${res.status}: ${errText.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };
    const preds = json.predictions ?? [];
    if (preds.length !== batch.length) {
      throw new Error(`embedTexts: expected ${batch.length} predictions, got ${preds.length}`);
    }
    for (const p of preds) {
      const values = p?.embeddings?.values;
      if (!Array.isArray(values) || values.length !== DEAL_EMBEDDING_DIMENSIONS) {
        throw new Error(`embedTexts: expected ${DEAL_EMBEDDING_DIMENSIONS} dims, got ${values?.length ?? 0}`);
      }
      out.push(values);
    }
  }

  return out;
}
