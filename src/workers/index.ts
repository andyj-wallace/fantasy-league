import { startLocalWorkerScheduler } from "./localScheduler";

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);

startLocalWorkerScheduler(intervalMs);
