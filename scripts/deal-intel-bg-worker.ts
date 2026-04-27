import "dotenv/config";
import { runBgWorkerLoop } from "@/lib/deal-intel/bg-worker";

runBgWorkerLoop({ workerId: `bg-worker:cli:${process.pid}` }).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

