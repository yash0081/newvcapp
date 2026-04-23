export function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

export function parseVector(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const arr = raw.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
    return arr.length ? arr : null;
  }
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const body = t.slice(1, -1).trim();
  if (!body) return null;
  const out = body
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  return out.length ? out : null;
}

export function parseVectorDim(raw: unknown, dim: number): number[] | null {
  const out = parseVector(raw);
  if (!out) return null;
  return out.length === dim ? out : null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
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

export function l2Normalize(values: number[]): number[] {
  let s = 0;
  for (const x of values) s += x * x;
  const n = Math.sqrt(s);
  if (n <= 1e-12) return values;
  return values.map((x) => x / n);
}

export function weightedCentroid(
  items: Array<{ vector: number[] | null; weight: number }>,
  normalize = true
): number[] | null {
  const valid = items.filter((x) => x.vector && x.vector.length > 0 && Number.isFinite(x.weight) && x.weight > 0) as Array<{
    vector: number[];
    weight: number;
  }>;
  if (valid.length === 0) return null;
  const dim = valid[0].vector.length;
  const acc = new Array(dim).fill(0);
  let wSum = 0;
  for (const it of valid) {
    if (it.vector.length !== dim) continue;
    for (let i = 0; i < dim; i++) {
      acc[i] += it.vector[i] * it.weight;
    }
    wSum += it.weight;
  }
  if (wSum <= 0) return null;
  const out = acc.map((x) => x / wSum);
  return normalize ? l2Normalize(out) : out;
}
