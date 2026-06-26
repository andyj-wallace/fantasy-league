import { playersRepository } from "../db/repositories";

/**
 * Wired and runnable, but fantasy_league_v1_design.txt only says "Monthly price updates" — no
 * formula for how much prices should move or what should drive it (form, ownership, transfers
 * in/out, etc. are all unspecified). This touches every Player's row with a $0 delta as a
 * placeholder; replace the price calculation once a real pricing rule is decided.
 */
export async function runMonthlyPriceUpdate(): Promise<void> {
  const players = await playersRepository.findMany({});
  for (const player of players) {
    await playersRepository.updatePrice(player.id, player.priceInMillions);
  }
}
