import type { ScheduledHandler } from "aws-lambda";
import { createFootballDataProviderFromEnv } from "./apiFootballProvider";
import { runWorkerCycle } from "./runWorkerCycle";

/** Entrypoint for the Lambda triggered by an EventBridge Scheduled Rule every 1-5 minutes. */
export const handler: ScheduledHandler = async () => {
  await runWorkerCycle(createFootballDataProviderFromEnv());
};
