"use client";

import { useEffect, useMemo, useRef } from "react";

type Page = {
  page_number: number;
  text: string;
};

type HighlightPart = string | { m: string };

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function FullDocumentViewer(props: {
  title: string;
  sourceLabel: string;
  pages: Page[];
  query?: string;
}) {
  const q = (props.query || "").trim();
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const rendered = useMemo(() => {
    if (!q) return props.pages.map((p) => ({ ...p, parts: [p.text] as HighlightPart[] }));
    const re = new RegExp(escapeRegExp(q), "ig");
    return props.pages.map((p) => {
      const parts: HighlightPart[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(p.text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > last) parts.push(p.text.slice(last, start));
        parts.push({ m: p.text.slice(start, end) });
        last = end;
        if (parts.length > 2000) break;
      }
      if (last < p.text.length) parts.push(p.text.slice(last));
      return { ...p, parts };
    });
  }, [props.pages, q]);

  useEffect(() => {
    if (!q) return;
    // Scroll to first highlight.
    const el = anchorRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "center" });
  }, [q]);

  let anchored = false;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-zinc-500">{props.sourceLabel}</p>
          <h1 className="text-lg font-semibold text-zinc-900 break-words">{props.title}</h1>
          {q ? <p className="text-xs text-zinc-500 mt-1">Jumped to first match for: <span className="font-medium text-zinc-700">{q}</span></p> : null}
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="space-y-6">
          {rendered.map((p) => (
            <div key={p.page_number} className="space-y-2">
              <p className="text-xs font-medium text-zinc-500">Page {p.page_number}</p>
              <div className="text-sm text-zinc-800 leading-relaxed whitespace-pre-wrap">
                {p.parts.map((part, idx) => {
                  if (typeof part === "string") return <span key={idx}>{part}</span>;
                  const ref = !anchored ? ((anchored = true), anchorRef) : undefined;
                  return (
                    <mark key={idx} ref={ref as unknown as React.RefObject<HTMLElement>} className="bg-yellow-200 text-zinc-900 px-0.5 rounded">
                      {part.m}
                    </mark>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

