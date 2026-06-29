import { StubFootballDataProvider, type FootballDataProvider } from "./footballDataProvider";
import { runWorkerCycle } from "./runWorkerCycle";

/** Repeatedly invokes runWorkerCycle() to simulate the EventBridge Scheduled Rule that triggers it in prod. */
export function startLocalWorkerScheduler(intervalMs: number, provider: FootballDataProvider = new StubFootballDataProvider()): void {
  void runWorkerCycle(provider);
  setInterval(() => {
    void runWorkerCycle(provider);
  }, intervalMs);
}
