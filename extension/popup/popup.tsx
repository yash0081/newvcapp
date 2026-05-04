import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { APP_ORIGIN } from "@shared/config";
import type {
  ActiveDealResponse,
  ExtensionRequest,
  ExtensionResponse,
  ListDealsResponse,
  SessionResponse,
} from "@shared/messages";
import type { ActiveDealHint, CopilotSession, DealListItem } from "@shared/types";

function send<T = unknown>(req: ExtensionRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res: ExtensionResponse | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res) {
        reject(new Error("Empty response"));
        return;
      }
      if (res.ok === false) {
        const err = new Error(res.error || "Background error") as Error & { status?: number };
        err.status = res.status;
        reject(err);
        return;
      }
      resolve(((res as { payload?: T }).payload as T) ?? (undefined as unknown as T));
    });
  });
}

function PopupApp() {
  const [activeDeal, setActiveDeal] = useState<ActiveDealHint | null>(null);
  const [deals, setDeals] = useState<DealListItem[]>([]);
  const [session, setSession] = useState<CopilotSession | null>(null);
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    try {
      const a = await send<ActiveDealResponse>({ type: "GET_ACTIVE_DEAL" });
      setActiveDeal(a.activeDeal);
      try {
        const list = await send<ListDealsResponse>({ type: "LIST_DEALS" });
        setDeals(list.deals ?? []);
        setSelectedDealId(a.activeDeal?.id ?? list.deals?.[0]?.id ?? null);
      } catch (e) {
        const status = (e as Error & { status?: number }).status;
        if (status === 401) {
          setNeedsAuth(true);
        } else {
          setError((e as Error).message);
        }
      }
      try {
        const s = await send<SessionResponse>({ type: "GET_ACTIVE_SESSION" });
        setSession(s.session);
        if (s.session?.status === "active") {
          void send({ type: "ENSURE_OVERLAY" }).catch(() => {});
        }
      } catch {
        setSession(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startSession = useCallback(async () => {
    if (!selectedDealId) return;
    setBusy("Starting session…");
    setError(null);
    try {
      const res = await send<SessionResponse>({
        type: "START_SESSION",
        dealId: selectedDealId,
      });
      setSession(res.session);
      if (res.session?.status === "active") {
        void send({ type: "ENSURE_OVERLAY" }).catch(() => {});
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [selectedDealId]);

  const endSession = useCallback(async () => {
    setBusy("Ending session…");
    setError(null);
    try {
      await send({ type: "END_SESSION" });
      setSession(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const openApp = useCallback((path: string) => {
    void send({ type: "OPEN_APP", path });
  }, []);

  const selectedDeal = useMemo(
    () => deals.find((d) => d.id === selectedDealId) ?? null,
    [deals, selectedDealId],
  );
  const sessionCompanyName = useMemo(() => {
    const metaName = session?.metadata?.company_name;
    if (typeof metaName === "string" && metaName.trim()) return metaName.trim();
    return deals.find((d) => d.id === session?.deal_id)?.company_name || activeDeal?.name || null;
  }, [activeDeal?.name, deals, session?.deal_id, session?.metadata?.company_name]);

  if (loading) {
    return (
      <div className="popup">
        <div className="title">Investora Labs research copilot</div>
        <div className="notice">Loading…</div>
      </div>
    );
  }

  if (needsAuth) {
    return (
      <div className="popup">
        <div className="title">Investora Labs research copilot</div>
        <div className="banner">Sign in at the Investora Labs tab to enable the copilot.</div>
        <div className="actions">
          <button className="btn primary" onClick={() => openApp("/")}>
            Open {new URL(APP_ORIGIN).host}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="popup">
      <div className="title">
        <span>Investora Labs research copilot</span>
        <button
          className="link"
          onClick={refresh}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {error ? <div className="banner">{error}</div> : null}

      {session ? (
        <div className="banner info">
          Currently researching <strong>{sessionCompanyName || "selected company"}</strong>
        </div>
      ) : null}

      <div className="subtitle">
        {activeDeal ? (
          <>
            Defaulting to <strong>{activeDeal.name}</strong> from your Investora Labs tab.
          </>
        ) : (
          <>Pick a deal to attach observations to.</>
        )}
      </div>

      {deals.length === 0 ? (
        <div className="notice">No deals yet. Create one in Investora Labs.</div>
      ) : (
        <div className="deal-list">
          {deals.map((deal) => {
            const selected = deal.id === selectedDealId;
            const isActive = deal.id === activeDeal?.id;
            return (
              <button
                key={deal.id}
                className={`deal${selected ? " selected" : ""}`}
                onClick={() => setSelectedDealId(deal.id)}
              >
                <span className="deal-name">{deal.company_name}</span>
                <span className="deal-meta">
                  {isActive ? "open in Investora Labs tab • " : ""}
                  updated {new Date(deal.updated_at).toLocaleDateString()}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="actions">
        {session ? (
          <button className="btn primary" onClick={endSession} disabled={!!busy}>
            {busy ?? "End research session"}
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={startSession}
            disabled={!selectedDeal || !!busy}
          >
            {busy ?? `Start session${selectedDeal ? ` • ${selectedDeal.company_name}` : ""}`}
          </button>
        )}
      </div>
    </div>
  );
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(<PopupApp />);
}
