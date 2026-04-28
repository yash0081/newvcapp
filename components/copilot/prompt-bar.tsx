"use client";

import { useState } from "react";

export function PromptBar(props: {
  busy: boolean;
  onSubmit: (text: string) => Promise<void> | void;
}) {
  const [text, setText] = useState("");

  async function send() {
    const t = text.trim();
    if (!t) return;
    setText("");
    await props.onSubmit(t);
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
      <p className="text-sm font-medium text-zinc-900">Ask the copilot</p>
      <p className="text-xs text-zinc-500">
        Examples: <span className="italic">add the 2025 revenue stats</span>, <span className="italic">grab the founders&apos; background</span>.
      </p>
      <div className="flex gap-2">
        <input
          className="crm-input flex-1"
          value={text}
          placeholder="Tell the copilot what to look for on the screen…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="crm-button" type="button" disabled={props.busy || !text.trim()} onClick={send}>
          {props.busy ? "Working…" : "Send"}
        </button>
      </div>
    </div>
  );
}
