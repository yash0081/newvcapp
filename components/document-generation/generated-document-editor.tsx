"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Save, Send } from "lucide-react";

type EditMessage = {
  role: "user" | "assistant";
  text: string;
};

export function GeneratedDocumentEditor({
  draftId,
  initialTitle,
  initialContent,
}: {
  draftId: string;
  initialTitle: string;
  initialContent: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editStatus, setEditStatus] = useState<"idle" | "applying" | "error">("idle");
  const [editInstruction, setEditInstruction] = useState("");
  const [editMessages, setEditMessages] = useState<EditMessage[]>([
    { role: "assistant", text: "Ask for a rewrite, a tighter section, a stronger memo tone, or any other document edit." },
  ]);
  const [error, setError] = useState("");

  function refreshPreview() {
    const frame = document.querySelector<HTMLIFrameElement>("[data-generated-document-preview='true']");
    if (!frame) return;
    const base = frame.src.split("?")[0] || frame.src;
    frame.src = `${base}?v=${Date.now()}`;
  }

  async function save() {
    setStatus("saving");
    setError("");
    try {
      const res = await fetch(`/api/document-generation/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; draft?: { title?: string; content?: string } } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setTitle(json?.draft?.title || title);
      setContent(json?.draft?.content || content);
      setStatus("saved");
      refreshPreview();
      setTimeout(() => setStatus("idle"), 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save document.");
      setStatus("error");
    }
  }

  async function applyEditInstruction() {
    const instruction = editInstruction.trim();
    if (!instruction) return;
    setEditInstruction("");
    setEditStatus("applying");
    setError("");
    setEditMessages((prev) => [...prev, { role: "user", text: instruction }]);
    try {
      const res = await fetch(`/api/document-generation/drafts/${draftId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const json = (await res.json().catch(() => null)) as
        | { error?: string; result?: { title?: string; content?: string; savedPreference?: string | null } }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setTitle(json?.result?.title || title);
      setContent(json?.result?.content || content);
      refreshPreview();
      setEditMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: json?.result?.savedPreference
            ? "Done. I updated the draft and saved that guidance for future documents of this type."
            : "Done. I updated the draft.",
        },
      ]);
      setEditStatus("idle");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to revise document.";
      setError(msg);
      setEditMessages((prev) => [...prev, { role: "assistant", text: msg }]);
      setEditStatus("error");
    }
  }

  return (
    <section className="crm-panel overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="crm-kicker">Editable document</p>
          {error ? <p className="mt-1 text-xs font-medium text-rose-600">{error}</p> : null}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={status === "saving" || !content.trim()}
          className="crm-button"
        >
          {status === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : status === "saved" ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {status === "saving" ? "Saving" : status === "saved" ? "Saved" : "Save edits"}
        </button>
      </div>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-950 outline-none focus:border-zinc-400"
            placeholder="Document title"
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-[520px] w-full resize-y rounded-xl border border-zinc-200 px-3 py-3 text-sm leading-relaxed text-zinc-900 outline-none focus:border-zinc-400"
            placeholder="Document content"
          />
        </div>
        <aside className="flex min-h-[360px] flex-col rounded-xl border border-zinc-200 bg-zinc-50">
          <div className="border-b border-zinc-200 px-3 py-3">
            <p className="text-sm font-semibold text-zinc-950">Edit chat</p>
            <p className="mt-0.5 text-xs text-zinc-500">Ask for writing edits to this draft.</p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {editMessages.map((message, index) => (
              <div
                key={`${message.role}_${index}`}
                className={message.role === "user" ? "ml-6 rounded-xl bg-zinc-900 px-3 py-2 text-sm leading-relaxed text-white" : "mr-6 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed text-zinc-800"}
              >
                {message.text}
              </div>
            ))}
          </div>
          <div className="border-t border-zinc-200 p-3">
            <textarea
              value={editInstruction}
              onChange={(event) => setEditInstruction(event.target.value)}
              className="min-h-20 w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-400"
              placeholder="Make the executive summary sharper..."
            />
            <button
              type="button"
              onClick={applyEditInstruction}
              disabled={!editInstruction.trim() || editStatus === "applying"}
              className="crm-button mt-2 w-full"
            >
              {editStatus === "applying" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {editStatus === "applying" ? "Applying" : "Apply edit"}
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
