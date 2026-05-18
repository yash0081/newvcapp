export type DocumentOutputFormat = "markdown" | "docx" | "pdf" | "text";

/** Human-readable label matching the Documents settings UI. */
export function documentOutputFormatLabel(format: string | null | undefined): string {
  const value = String(format || "")
    .trim()
    .toLowerCase();
  if (value === "docx") return "Word document";
  if (value === "pdf") return "PDF";
  if (value === "text" || value === "markdown") return "Plain text";
  if (!value) return "Document";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
