import type { ScheduledHandler } from "aws-lambda";
import { loadRuntimeConfigFromSsm } from "../runtimeConfig/loadRuntimeConfigFromSsm";

/** The db pool reads DATABASE_URL at import time, so the worker modules can only be imported
 * after the SSM secrets have been loaded into process.env. Once per cold start. */
const initializedPriceUpdate = (async () => {
  await loadRuntimeConfigFromSsm();
  const { runMonthlyPriceUpdate } = await import("./runMonthlyPriceUpdate");
  return { runMonthlyPriceUpdate };
})();

/** Entrypoint for the Lambda triggered by its own EventBridge Scheduled Rule (PRICE_UPDATE_DAY), once a month. */
export const handler: ScheduledHandler = async () => {
  const { runMonthlyPriceUpdate } = await initializedPriceUpdate;
  await runMonthlyPriceUpdate();
};
