export function formatSupabaseError(err: unknown, fallback = "Supabase error"): string {
  if (!err) return fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const parts = [obj.message, obj.details, obj.hint, obj.code]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(obj);
    } catch {
      return fallback;
    }
  }
  return String(err);
}

export function toError(err: unknown, fallback = "Operation failed"): Error {
  return new Error(formatSupabaseError(err, fallback));
}

