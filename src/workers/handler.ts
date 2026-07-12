import type { ScheduledHandler } from "aws-lambda";
import { loadRuntimeConfigFromSsm } from "../runtimeConfig/loadRuntimeConfigFromSsm";

/** The db pool reads DATABASE_URL at import time, so the worker modules can only be imported
 * after the SSM secrets have been loaded into process.env. Once per cold start. */
const initializedWorker = (async () => {
  await loadRuntimeConfigFromSsm();
  const { runWorkerCycle } = await import("./runWorkerCycle");
  const { createFootballDataProviderFromEnv } = await import("./createFootballDataProviderFromEnv");
  return { runWorkerCycle, createFootballDataProviderFromEnv };
})();

/** Entrypoint for the Lambda triggered by an EventBridge Scheduled Rule every 1-5 minutes. */
export const handler: ScheduledHandler = async () => {
  const { runWorkerCycle, createFootballDataProviderFromEnv } = await initializedWorker;
  await runWorkerCycle(createFootballDataProviderFromEnv());
};
