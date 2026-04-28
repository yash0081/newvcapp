"use client";

import type { AcceptedSnippet } from "@/lib/copilot/types";

export function SnippetBuffer(props: { snippets: AcceptedSnippet[] }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-900">Saved this session</p>
        <span className="text-[11px] text-zinc-500">{props.snippets.length}</span>
      </div>
      {props.snippets.length === 0 ? (
        <p className="text-xs text-zinc-500">
          Accepted suggestions will collect here. Click Finalize and save when you&apos;re done to add them as one deal document.
        </p>
      ) : (
        <div className="space-y-2 max-h-[480px] overflow-auto pr-1">
          {props.snippets
            .slice()
            .reverse()
            .map((s, i) => (
              <div key={`${s.accepted_at}_${i}`} className="rounded-xl border border-zinc-200 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-zinc-500">{s.source_label || s.hostname || "screen"}</span>
                  <span className="text-[10px] text-zinc-400">{new Date(s.accepted_at).toLocaleTimeString()}</span>
                </div>
                <p className="text-xs text-zinc-700 whitespace-pre-wrap mt-1">{s.text}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
