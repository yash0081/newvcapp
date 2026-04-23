/**
 * Extract JSON objects from Invested Companies_.md (escaped keys like company\_name).
 */

function unescapeJsonFragment(s: string): string {
  return s
    .replace(/\\_/g, "_")
    .replace(/\\\\/g, "\\")
    .replace(/\\\)/g, ")")
    .replace(/\\\(/g, "(");
}

export type InvestedCompanyRecord = {
  cohort: "invested" | "passed" | "unknown";
  rawJson: Record<string, unknown>;
};

export function parseInvestedCompaniesMarkdown(md: string): InvestedCompanyRecord[] {
  const out: InvestedCompanyRecord[] = [];
  let cohort: "invested" | "passed" | "unknown" = "unknown";
  const lines = md.split(/\n/);

  for (const line of lines) {
    const t = line.trim();
    if (/^Invested Companies/i.test(t)) {
      cohort = "invested";
      continue;
    }
    if (/^Non Invested Companies/i.test(t)) {
      cohort = "passed";
      continue;
    }
    if (/^Passed Companies/i.test(t)) {
      cohort = "passed";
      continue;
    }
    if (!t.startsWith("{")) continue;
    try {
      const fixed = unescapeJsonFragment(t);
      const raw = JSON.parse(fixed) as Record<string, unknown>;
      out.push({ cohort, rawJson: raw });
    } catch {
      // skip
    }
  }

  return out;
}
