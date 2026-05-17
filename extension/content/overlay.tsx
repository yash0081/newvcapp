import { createRoot } from "react-dom/client";
import { Overlay } from "@content/overlay-ui";
import type {
  ActiveDealResponse,
  ExtensionRequest,
  SessionResponse,
} from "@shared/messages";
import styles from "@content/styles.css?inline";

const HOST_ID = "vcapp-copilot-overlay-host";

function send<T = unknown>(req: ExtensionRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res || typeof res !== "object") {
        reject(new Error("Empty response from background"));
        return;
      }
      if ((res as { ok?: boolean }).ok === false) {
        reject(new Error((res as { error?: string }).error || "Background error"));
        return;
      }
      resolve(((res as { payload?: T }).payload as T) ?? (undefined as unknown as T));
    });
  });
}

async function bootstrap() {
  if (document.getElementById(HOST_ID)) return;
  if (window.top !== window.self) return; // only mount in top frame
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.right = "0";
  host.style.zIndex = "2147483647";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open", delegatesFocus: true });
  const styleEl = document.createElement("style");
  styleEl.textContent = styles;
  shadow.appendChild(styleEl);
  const reactMount = document.createElement("div");
  shadow.appendChild(reactMount);

  // Probe state via background; treat errors (e.g. signed-out) as null state.
  let activeDeal = null as null | { id: string; name: string };
  let initialSession = null as null | Awaited<ReturnType<typeof send<SessionResponse>>>["session"];
  try {
    const a = await send<ActiveDealResponse>({ type: "GET_ACTIVE_DEAL" });
    activeDeal = a.activeDeal;
  } catch {
    activeDeal = null;
  }
  try {
    const s = await send<SessionResponse>({ type: "GET_ACTIVE_SESSION" });
    initialSession = s?.session ?? null;
  } catch {
    initialSession = null;
  }

  const root = createRoot(reactMount);
  root.render(<Overlay activeDeal={activeDeal} initialSession={initialSession} />);
}

void bootstrap();
