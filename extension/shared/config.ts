// Compile-time configuration for the extension. The Next.js app's origin is
// baked in via VITE_APP_ORIGIN at build time; falls back to localhost for dev.

const RAW = (import.meta.env.VITE_APP_ORIGIN ?? "http://localhost:3000").trim();
export const APP_ORIGIN = RAW.replace(/\/$/, "");
export const ACTIVE_DEAL_COOKIE = "vcapp_active_deal";

// Snapshot caps mirror the server-side limits in lib/copilot/extracted-snapshot.ts
// so we never send something the server will reject as too large.
export const MAX_SNAPSHOT_TEXT_CHARS = 3000;
export const MIN_OBSERVE_SPACING_MS = 800;
export const MAX_OUTBOUND_LINKS = 10;
