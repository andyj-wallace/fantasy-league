import type { ScheduledHandler } from "aws-lambda";
import { runMonthlyPriceUpdate } from "./runMonthlyPriceUpdate";

/** Entrypoint for the Lambda triggered by its own EventBridge Scheduled Rule (PRICE_UPDATE_DAY), once a month. */
export const handler: ScheduledHandler = async () => {
  await runMonthlyPriceUpdate();
};
