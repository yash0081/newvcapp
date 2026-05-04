import { defineManifest } from "@crxjs/vite-plugin";

// Read the app domain from env at build time so devs and prod builds use the
// right host_permissions and CORS-allowed origin.
const APP_ORIGIN = (process.env.VITE_APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const APP_HOST_MATCH = `${APP_ORIGIN}/*`;

export default defineManifest({
  manifest_version: 3,
  name: "Investora Labs — research copilot",
  version: "0.1.0",
  description:
    "Reads the current page's text and surfaces deal-relevant suggestions for Investora Labs research workflows.",
  permissions: ["storage", "activeTab", "cookies", "scripting"],
  host_permissions: [APP_HOST_MATCH, "https://*/*", "http://localhost/*"],
  background: {
    service_worker: "background/service-worker.ts",
    type: "module",
  },
  action: {
    default_popup: "popup/popup.html",
    default_title: "Investora Labs research copilot",
  },
  externally_connectable: {
    matches: [APP_HOST_MATCH],
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      exclude_matches: [APP_HOST_MATCH],
      js: ["content/overlay.tsx"],
      run_at: "document_idle",
    },
  ],
});
