# Investora Labs research copilot — Chrome extension

This is a Manifest V3 Chrome extension that overlays the Investora Labs research copilot directly on the page you're researching. It reads the current tab's DOM (no screenshots), sends it to your existing `/api/copilot/*` endpoints, and renders suggestions, a prompt bar, and a snippet buffer in a shadow-DOM panel that can't bleed into the host page's CSS.

It is a separate package from the Next.js app and is **not** bundled with `next build`.

## Repo layout

```
extension/
  manifest.config.ts        # crxjs manifest definition (uses VITE_APP_ORIGIN)
  vite.config.ts            # Vite + @crxjs/vite-plugin
  tsconfig.json
  package.json
  background/
    service-worker.ts       # session state + message router; calls the API
  content/
    overlay.tsx             # mount + shadow-DOM bootstrap
    overlay-ui.tsx          # React overlay UI
    extractor.ts            # DOM -> structured snapshot
    styles.css              # scoped to the shadow root
  popup/
    popup.html / popup.tsx  # deals picker, defaults to vcapp_active_deal
  shared/
    api.ts                  # fetch wrappers for /api/copilot/*
    config.ts               # APP_ORIGIN, caps
    messages.ts             # cross-context message types
    types.ts                # subset of lib/copilot/types.ts
```

## Prerequisites

1. The Next.js app is running at the origin you configure below (e.g. `http://localhost:3000`) and you can sign in to it.
2. The SQL migration `supabase/migrations/00000000000006_copilot_sessions.sql` has been applied to your Supabase database.

## Install + dev loop

```bash
cd extension
npm install
npm run dev
```

The first run produces `extension/dist`. Vite watches your source files and rebuilds incrementally.

In Chrome:
1. Visit `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/dist`.
4. Pin the extension so its action button is visible.
5. After every code change, click the **reload** icon on the extension card and refresh the target tab. The popup updates without reloading.

## Configuration

The extension reads `VITE_APP_ORIGIN` at build time. It is the origin of your Next.js app (no trailing slash). Either:

- Pass it inline: `VITE_APP_ORIGIN=https://app.example.com npm run dev`
- Or create `extension/.env.local` with `VITE_APP_ORIGIN=https://app.example.com`

The Next.js side needs to allow the extension's origin in CORS. Set one of these on the **Next.js** environment:

- Production: `COPILOT_ALLOWED_EXTENSION_ORIGINS=chrome-extension://<your-extension-id>` (comma-separated for multiple).
- Local dev: `COPILOT_ALLOW_DEV_EXTENSION=1` to accept any `chrome-extension://*` origin during development.

## How auth works

The extension never calls `/auth/*`. Every request to `/api/copilot/*` is sent with `credentials: "include"`, so the Supabase auth cookie set on your Next.js app's domain rides along (provided the manifest declares `host_permissions` for that domain, which it does at build time via `VITE_APP_ORIGIN`). If you're not signed in, the popup shows a "Sign in at <APP>" CTA.

## Active-deal default

When you visit `/home/deal-intel/<id>` in the Next.js app, the page sets a non-HttpOnly cookie called `vcapp_active_deal` containing `{ id, name }`. The extension popup reads it via `chrome.cookies.get` and defaults the deal picker to that deal so you can start a session in one click.

## Logs

- **Content script**: target page DevTools → Console.
- **Service worker**: `chrome://extensions` → the extension card → "service worker" link → DevTools.
- **Popup**: right-click the popup → Inspect.

## What "done" looks like

- Install the unpacked extension; click its icon while on a third-party site (e.g. linkedin.com).
- The popup lists your recent deals; the deal you're viewing in your Investora Labs tab is highlighted.
- Click **Start session** in the popup, or **Start session here** in the on-page overlay.
- An overlay appears top-right of the tab. Click **Analyze this page** — within a few seconds, suggestion cards appear inside the overlay.
- Accept one — it appears under **Saved**.
- Click **Finalize** — the Next.js app shows a new `deal_intel.document` (`source_kind: "copilot_session"`) attached to that deal.

## Privacy + cost guards

- Extraction is **on-demand** by default. Auto-mode (toggle in the overlay) re-analyzes only on URL changes or significant DOM mutations, debounced 4 s.
- Snapshot text is capped to 5,000 chars before being sent.
- The service worker enforces "max 1 observe in flight per session" and a 4 s minimum spacing between observations.
- Common secrets-shaped lines (`password`, `otp`, `api key`, etc.) are dropped client-side before send.
- The content script is excluded from the Investora Labs app domain so the overlay never reads your own CRM pages.

## Out of scope (MVP)

- No browser store submission; load-unpacked only for now.
- No per-site adapters yet (LinkedIn, Crunchbase, etc.). The generic readability + text walker is enough to validate the loop.
- No Firefox/Safari support.
- The previous screen-share copilot at `/home/deal-intel/[id]/copilot` remains as a fallback for sites where DOM extraction is poor (PDF viewers, canvas-only apps).
