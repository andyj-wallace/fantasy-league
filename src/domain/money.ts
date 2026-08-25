/**
 * Every money value in the game lives on a £0.1M grid: player prices are quantized to it when they
 * are set (calculateNewPriceInMillions), and budgets are only ever those prices added and
 * subtracted. Nothing in the game can legitimately hold a value between two grid points.
 *
 * Floating-point arithmetic does not preserve that invariant. `110 - 10.3` is 99.69999999999999,
 * and the two paths that produce a team's remaining budget — one `reduce` over 16 prices in
 * setTeamRoster, versus a chain of `budget + out - in` steps in makeTransfer — accumulate error
 * differently. Two teams that have provably spent the same amount end up holding different doubles.
 *
 * That matters because the standings tiebreaker compares total spend for exact equality
 * (compareRankableTeamStandings): a ~1e-6 difference splits teams that should share a rank, and
 * the resulting rank is then persisted into league_standings. It also matters for affordability
 * checks, where a player priced at exactly the remaining budget can read as unaffordable.
 *
 * The fix is to snap back to the grid at every boundary — after arithmetic and on the way out of
 * the database — so a money value is always the canonical double for its grid point and equality
 * means what it says.
 *
 * Note this is NOT about the columns being `real` (float4). float4 carries a £0.1M-grid value up
 * to £110M with a worst-case error of ~3e-6, four orders of magnitude below the 0.05 needed to
 * round back to the right grid point. The storage is faithful; the arithmetic around it was not.
 */

/** Money is denominated in whole tenths of a million — £0.1M is the smallest representable amount. */
const GRID_STEPS_PER_MILLION = 10;

/**
 * Snaps a money amount back onto the £0.1M grid, undoing floating-point drift accumulated by
 * addition and subtraction. Apply after any arithmetic on money, and when reading money out of
 * the database, so that two amounts that are equal in the game are equal as JavaScript numbers.
 */
export function roundToNearestTenthOfMillion(amountInMillions: number): number {
  return Math.round(amountInMillions * GRID_STEPS_PER_MILLION) / GRID_STEPS_PER_MILLION;
}
