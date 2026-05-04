/**
 * CLI worker runs under `tsx`, not the Next.js bundler. The real `server-only`
 * package throws on import; Next replaces it in app builds. Patch before any
 * `@/` imports so copilot / lib modules can load.
 */
import Module from "node:module";

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleWithLoad = Module as unknown as ModuleWithLoad;
const origLoad = moduleWithLoad._load.bind(Module);
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad(request, parent, isMain);
};

void import("./deal-intel-bg-worker-run").catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
