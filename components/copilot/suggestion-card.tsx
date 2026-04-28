"use client";

import type { Suggestion } from "@/lib/copilot/types";

function kindClass(kind: Suggestion["kind"]): string {
  switch (kind) {
    case "new":
      return "text-emerald-700 bg-emerald-50";
    case "aligns":
      return "text-blue-700 bg-blue-50";
    case "contradicts":
      return "text-rose-700 bg-rose-50";
  }
}

export function SuggestionCard(props: {
  suggestion: Suggestion & { event_id: string };
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const s = props.suggestion;
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${kindClass(s.kind)}`}>
          {s.kind}
        </span>
        <span className="text-[11px] text-zinc-500">
          {Math.round(s.confidence * 100)}% · {s.source_label}
        </span>
      </div>
      <p className="text-sm text-zinc-900">{s.summary}</p>
      <p className="text-xs text-zinc-700 whitespace-pre-wrap line-clamp-6">{s.snippet}</p>
      <div className="flex gap-2 pt-1">
        <button className="crm-button-secondary" type="button" disabled={props.busy} onClick={props.onAccept}>
          Save to deal
        </button>
        <button className="crm-button-secondary" type="button" disabled={props.busy} onClick={props.onReject}>
          Skip
        </button>
      </div>
    </div>
  );
}
