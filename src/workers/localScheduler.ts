import { runWorkerCycle } from "./runWorkerCycle";

/** Repeatedly invokes runWorkerCycle() to simulate the EventBridge Scheduled Rule that triggers it in prod. */
export function startLocalWorkerScheduler(intervalMs: number): void {
  void runWorkerCycle();
  setInterval(() => {
    void runWorkerCycle();
  }, intervalMs);
}
