import "dotenv/config";
import { startLocalMonthlyPriceUpdateScheduler } from "./localMonthlyPriceUpdateScheduler";

const intervalMs = Number(process.env.PRICE_UPDATE_INTERVAL_MS ?? 30 * 24 * 60 * 60 * 1000);

startLocalMonthlyPriceUpdateScheduler(intervalMs);
