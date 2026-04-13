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

let authClient: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!authClient) authClient = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return authClient;
}

/**
 * Embed a single text chunk via Vertex `publishers/google/models/{model}:predict`.
 */
export async function embedText(text: string): Promise<number[]> {
  const { projectId, location, model } = embeddingEnv();
  if (!projectId) {
    throw new Error("GOOGLE_CLOUD_PROJECT is not set");
  }
  const trimmed = text.trim().slice(0, MAX_CHARS);
  if (!trimmed) {
    throw new Error("embedText: empty text");
  }
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("embedText: failed to get access token");
  }
  const host = `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      instances: [{ content: trimmed }],
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
  const values = json.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || values.length !== DEAL_EMBEDDING_DIMENSIONS) {
    throw new Error(`embedText: expected ${DEAL_EMBEDDING_DIMENSIONS} dims, got ${values?.length ?? 0}`);
  }
  return values;
}
