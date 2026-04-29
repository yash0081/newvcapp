import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": new URL("./shared", import.meta.url).pathname,
      "@content": new URL("./content", import.meta.url).pathname,
      "@background": new URL("./background", import.meta.url).pathname,
      "@popup": new URL("./popup", import.meta.url).pathname,
    },
  },
  server: {
    // crxjs picks a random port by default; pin to keep extension reload friendly.
    port: 5174,
    strictPort: false,
    hmr: { port: 5174 },
  },
});
