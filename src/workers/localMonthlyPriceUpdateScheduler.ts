import { runMonthlyPriceUpdate } from "./runMonthlyPriceUpdate";

/** Repeatedly invokes runMonthlyPriceUpdate() to simulate its EventBridge Scheduled Rule locally.
 * Prod's actual monthly cadence comes from that rule's cron expression, not this interval. */
export function startLocalMonthlyPriceUpdateScheduler(intervalMs: number): void {
  void runMonthlyPriceUpdate();
  setInterval(() => {
    void runMonthlyPriceUpdate();
  }, intervalMs);
}
