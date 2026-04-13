import { embedText } from "@/lib/vertex-embeddings";

export type ClaimSource = "problem" | "solution" | "traction";

export type Claim = {
  subject: string;
  predicate: string;
  object: string;
  source: ClaimSource;
  confidence: number;
  evidence: string;
};

export type EmbeddedClaim = Claim & {
  embedding: number[];
};

export type ClaimCluster = {
  cluster_id: string;
  medoid_index: number;
  claims: EmbeddedClaim[];
};

function safeStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function safeNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function normalizeClaim(raw: unknown): Claim | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const subject = safeStr(r.subject);
  const predicate = safeStr(r.predicate);
  const object = safeStr(r.object);
  const evidence = safeStr(r.evidence);
  const source = safeStr(r.source) as ClaimSource;
  const confidence = Math.max(0, Math.min(10, Math.round(safeNum(r.confidence))));
  if (!subject || !predicate || !object) return null;
  if (source !== "problem" && source !== "solution" && source !== "traction") return null;
  return { subject, predicate, object, source, confidence, evidence };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (an <= 0 || bn <= 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function embedTextForClaim(c: Claim): string {
  // Compact, stable representation for clustering.
  return `${c.subject} | ${c.predicate} | ${c.object}`.slice(0, 2000);
}

export async function embedClaims(claims: Claim[]): Promise<EmbeddedClaim[]> {
  const clean = claims.filter(Boolean);
  const vecs = await Promise.all(clean.map((c) => embedText(embedTextForClaim(c))));
  return clean.map((c, i) => ({ ...c, embedding: vecs[i] }));
}

class Dsu {
  parent: number[];
  size: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = Array.from({ length: n }, () => 1);
  }
  find(x: number): number {
    let p = this.parent[x];
    while (p !== this.parent[p]) p = this.parent[p];
    while (x !== p) {
      const nx = this.parent[x];
      this.parent[x] = p;
      x = nx;
    }
    return p;
  }
  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
  }
}

function medoidIndex(items: EmbeddedClaim[], indices: number[]): number {
  if (indices.length === 1) return indices[0];
  // Exact medoid on small clusters: minimize average cosine distance.
  let best = indices[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const i of indices) {
    let sumDist = 0;
    for (const j of indices) {
      if (i === j) continue;
      const sim = cosineSimilarity(items[i].embedding, items[j].embedding);
      sumDist += 1 - sim;
    }
    const avg = sumDist / Math.max(1, indices.length - 1);
    if (avg < bestScore) {
      bestScore = avg;
      best = i;
    }
  }
  return best;
}

export function clusterClaimsOffline(args: {
  embedded: EmbeddedClaim[];
  threshold?: number;
}): ClaimCluster[] {
  const { embedded } = args;
  const threshold = typeof args.threshold === "number" ? args.threshold : 0.86;
  const n = embedded.length;
  if (n === 0) return [];
  const dsu = new Dsu(n);

  // Offline-only: brute-force candidate pairs (n is small; typical 20–40).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(embedded[i].embedding, embedded[j].embedding);
      if (sim >= threshold) dsu.union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  }

  let k = 0;
  const clusters: ClaimCluster[] = [];
  for (const indices of groups.values()) {
    const medoid = medoidIndex(embedded, indices);
    clusters.push({
      cluster_id: `c_${k++}`,
      medoid_index: indices.indexOf(medoid),
      claims: indices.map((idx) => embedded[idx]),
    });
  }
  return clusters;
}

export function hasCrossSourcePairs(cluster: ClaimCluster): boolean {
  const sources = new Set(cluster.claims.map((c) => c.source));
  return sources.size >= 2;
}

