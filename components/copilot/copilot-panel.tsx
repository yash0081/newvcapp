"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcceptedSnippet, CopilotSession, Suggestion } from "@/lib/copilot/types";
import { ScreenWatcher } from "@/components/copilot/screen-watcher";
import { SuggestionCard } from "@/components/copilot/suggestion-card";
import { PromptBar } from "@/components/copilot/prompt-bar";
import { SnippetBuffer } from "@/components/copilot/snippet-buffer";

type ServerSuggestion = Suggestion & { event_id: string };

export function CopilotPanel(props: {
  dealId: string;
  companyName: string;
  initialSession: CopilotSession | null;
}) {
  const [session, setSession] = useState<CopilotSession | null>(props.initialSession);
  const [suggestions, setSuggestions] = useState<ServerSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [latestFrameRef, setLatestFrameRef] = useState<string | null>(null);

  const acceptedSnippets: AcceptedSnippet[] = useMemo(() => {
    const meta = (session?.metadata ?? {}) as { acceptedSnippets?: AcceptedSnippet[] };
    return Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets : [];
  }, [session]);

  const inflight = useRef(false);

  async function startSession() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/copilot/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: props.dealId }),
      });
      const json = (await res.json().catch(() => null)) as { session?: CopilotSession; error?: string } | null;
      if (!res.ok || !json?.session) throw new Error(json?.error || `Failed (${res.status})`);
      setSession(json.session);
      setSuggestions([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSession() {
    if (!session) return;
    const res = await fetch(`/api/copilot/sessions/by-deal/${props.dealId}`);
    const json = (await res.json().catch(() => null)) as { session?: CopilotSession | null } | null;
    if (json?.session) setSession(json.session);
  }

  const sendObservation = useCallback(
    async (imageBase64: string, mimeType: string, hostnameHint?: string) => {
      if (!session) return;
      if (inflight.current) return;
      inflight.current = true;
      setLatestFrameRef(imageBase64);
      try {
        const res = await fetch(`/api/copilot/sessions/${session.id}/observe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: imageBase64,
            mimeType,
            capturedAt: new Date().toISOString(),
            hostnameHint: hostnameHint ?? null,
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { suggestions?: ServerSuggestion[]; error?: string; reason?: string }
          | null;
        if (!res.ok) {
          setError(json?.error || `Observe failed (${res.status})`);
          return;
        }
        const next = Array.isArray(json?.suggestions) ? json.suggestions : [];
        if (next.length) {
          setSuggestions((prev) => {
            const seen = new Set(prev.map((s) => s.event_id));
            return [...next.filter((s) => !seen.has(s.event_id)), ...prev].slice(0, 12);
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inflight.current = false;
      }
    },
    [session]
  );

  async function decide(suggestion: ServerSuggestion, action: "accept" | "reject") {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/copilot/sessions/${session.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionEventId: suggestion.event_id, action }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Decision failed (${res.status})`);
      setSuggestions((prev) => prev.filter((s) => s.event_id !== suggestion.event_id));
      if (action === "accept") await refreshSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitPrompt(text: string) {
    if (!session) {
      setError("Start a session first.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/copilot/sessions/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          image: latestFrameRef,
          mimeType: "image/jpeg",
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { suggestions?: ServerSuggestion[]; error?: string; reply?: string }
        | null;
      if (!res.ok) throw new Error(json?.error || `Prompt failed (${res.status})`);
      const next = Array.isArray(json?.suggestions) ? json.suggestions : [];
      if (next.length) {
        setSuggestions((prev) => [...next, ...prev].slice(0, 12));
      } else if (json?.reply) {
        setMessage(json.reply);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!session) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/copilot/sessions/${session.id}/finalize`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as { documentId?: string; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Finalize failed (${res.status})`);
      setMessage(
        json?.documentId
          ? "Saved as a deal document. You can find it under the deal docs."
          : "Session ended (nothing to save)."
      );
      setSession(null);
      setSuggestions([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setSuggestions([]);
  }, [session?.id]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{props.companyName} research copilot</h2>
            <p className="text-xs text-zinc-500">
              Share a tab. Every few seconds the copilot reads the screen and suggests info to add to this deal.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!session ? (
              <button className="crm-button" onClick={startSession} disabled={busy} type="button">
                {busy ? "Starting…" : "Start session"}
              </button>
            ) : (
              <>
                <button
                  className="crm-button-secondary"
                  onClick={() => setPaused((p) => !p)}
                  disabled={busy}
                  type="button"
                >
                  {paused ? "Resume watching" : "Pause"}
                </button>
                <button className="crm-button" onClick={finalize} disabled={busy} type="button">
                  {busy ? "Saving…" : "Finalize and save"}
                </button>
              </>
            )}
          </div>
        </div>
        {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
      </div>

      {session ? (
        <ScreenWatcher
          sessionId={session.id}
          paused={paused}
          onPausedChange={setPaused}
          onFrame={sendObservation}
          onError={(msg) => setError(msg)}
        />
      ) : null}

      {session ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
              <p className="text-sm font-medium text-zinc-900">Suggestions</p>
              {suggestions.length === 0 ? (
                <p className="text-xs text-zinc-500">No suggestions yet. Move around the page or ask the copilot for something specific.</p>
              ) : (
                <div className="space-y-2">
                  {suggestions.map((s) => (
                    <SuggestionCard
                      key={s.event_id}
                      suggestion={s}
                      busy={busy}
                      onAccept={() => decide(s, "accept")}
                      onReject={() => decide(s, "reject")}
                    />
                  ))}
                </div>
              )}
            </div>
            <PromptBar busy={busy} onSubmit={submitPrompt} />
          </div>
          <SnippetBuffer snippets={acceptedSnippets} />
        </div>
      ) : null}
    </div>
  );
}
