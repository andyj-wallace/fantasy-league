import type { MatchStatus } from "./shared";

/** A real-world Premier League fixture, imported from the football data provider. */
export interface Match {
  id: string;
  /** The football data provider's fixture ID; null until the importer first sees this fixture. */
  externalId: string | null;
  gameweekId: string;
  homeClub: string;
  awayClub: string;
  kickoffAt: Date;
  status: MatchStatus;
  /** Present once the match reaches COMPLETED. */
  finalHomeScore: number | null;
  finalAwayScore: number | null;
}

/**
 * Statuses meaning a fixture is under way and its outcome is still unknown to us — the rows the
 * live poller still owes an answer on.
 *
 * INTERRUPTED (the provider's SUSP/INT) sits beside IN_PROGRESS because it is *not* terminal: a
 * suspended match either resumes or is abandoned, and only a later provider answer can say which.
 * Leaving it out made an INTERRUPTED row unreachable by the poller forever — the same dead end
 * docs/stuck-live-match-reconciliation-plan.md was written to remove — and because INTERRUPTED is
 * one of MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION below, that one row held its whole
 * gameweek open (no free-transfer award, no final standings) until the 12-hourly discovery pass
 * healed it.
 *
 * Two places must agree on this rule: matchesRepository.findPotentiallyLive, which decides whether
 * such a row is handed to the live tick at all, and liveMatchPolling's reconciliation/pacing, which
 * decides whether to chase it. It lives here so they share one definition rather than mirroring a
 * status list across the db and worker layers.
 */
export const MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED: MatchStatus[] = ["IN_PROGRESS", "INTERRUPTED"];

/**
 * Statuses that still hold a gameweek open — the fixtures a round is genuinely waiting on before it
 * can be closed, pay its free transfers and be given final standings. Every other status has
 * stopped blocking, and the list is written the blocking way round precisely so that adding a new
 * MatchStatus has to be an explicit decision to hold rounds open rather than a silent one.
 *
 * COMPLETED and VOIDED are non-blocking because they are terminal. POSTPONED is non-blocking for a
 * different reason: the fixture is still owed, but it is owed on some *later* date, and nothing
 * about withholding this round's settlement brings it forward. Counting it as blocking — which this
 * codebase did until 2026-08-26 — meant a single postponement held its whole round open
 * indefinitely: no 2-per-gameweek free-transfer award for anyone, no final standings, and, because
 * gameweeksRepository.findCurrent is "the lowest-numbered non-COMPLETED gameweek", the entire
 * season-awareness UI (gameweek banner, lock context, standings labels) pinned to a round the
 * season had long since played past. Managers who actually lost players to the postponement are
 * compensated separately and per club by awardPostponedMatchTransfers, so the delay bought nothing.
 * When the fixture is finally replayed it scores back into this gameweek and
 * rebuildGameweekScoresAndStandings corrects the round and cascades into every later one — the same
 * retro-correction path a late stat correction already takes.
 *
 * Two places must agree on this rule, for the same reason as the constant above:
 * gameweeksRepository.hasEveryMatchStoppedBlockingGameweekCompletion, which decides when the worker
 * closes a round, and summarizeGameweekMatchProgress, which tells managers when to expect their
 * scores. They disagreed once before and it was a real bug.
 */
export const MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION: MatchStatus[] = [
  "SCHEDULED",
  "DELAYED",
  "IN_PROGRESS",
  "INTERRUPTED",
];
/**
 * How long after kickoff the live poller keeps asking about a fixture that has never reached a
 * terminal status. Past this it lets go: it stops spending provider calls on the row and says so in
 * the log, leaving the twice-daily discovery pass to heal it if it can.
 *
 * Why a bound has to exist at all: the tick is armed by findPotentiallyLive returning *anything*.
 * With no lower bound on kickoff, one stale non-terminal row — a seed, a fixture from a previous
 * season, one the provider quietly dropped, rescheduleGameweekIntoFuture drift — keeps that query
 * permanently non-empty and so keeps the tick permanently armed: a fetchLiveFixtures on every idle
 * tick (~48/day), plus a targeted reconciliation lookup on every tick once the row clears
 * MISSING_KICKOFF_GRACE_MS, forever, off-season included. And it is a closed loop: `live=all` never
 * mentions a fixture that is not in play, and if the provider no longer recognises the id then
 * reconciliation comes back empty too, so nothing the poller can do will ever clear the row.
 *
 * Why 24 hours specifically: it must comfortably exceed DISCOVERY_GATE_MS (12h, runWorkerCycle.ts).
 * Discovery calls fetchSeasonFixtures, which — unlike the live list — does carry terminal statuses,
 * and is therefore the only pass that can actually resolve a stuck row. At 24h it gets at least one
 * full attempt, in practice two, before the poller stops looking. A window at or below that gate
 * would abandon rows to a pass that had not yet run.
 *
 * Enforced in exactly one place: liveMatchPolling, which partitions what findPotentiallyLive
 * returned before the length check that arms the tick. It is deliberately *not* also a predicate in
 * that query's SQL. Filtering the rows out in the database would save nothing worth having — the
 * cost being avoided is provider calls, not a local indexed read over a few hundred fixtures a
 * season — and it would cost the one thing that matters: an abandoned row would disappear silently
 * while still blocking its gameweek forever (its status is still one of
 * MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION),
 * leaving a permanently stuck fixture with no signal anywhere. Before this window existed such a row
 * at least announced itself by burning quota. It has to stay visible to the layer that gives up on
 * it. One enforcement point is also one fewer pair of layers that can drift apart on a polling rule
 * — the drift that made an INTERRUPTED row unreachable in 2026-08-23, and the reason
 * MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED lives beside this.
 */
export const MATCH_POLLING_ABANDONMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The oldest kickoff the live poller will still chase. Exposed beside the partition so the cutoff
 * is stated once and can be asserted directly, rather than re-derived at each use. */
export function resolveEarliestKickoffStillWorthPolling(now: Date): Date {
  return new Date(now.getTime() - MATCH_POLLING_ABANDONMENT_WINDOW_MS);
}

export interface MatchPollingAbandonmentPartition<TMatch> {
  /** Recent enough that the poller should still be spending provider calls on them. */
  stillWithinPollingWindow: TMatch[];
  /** Older than the window and still not terminal — the poller lets go; discovery owns them now. */
  abandonedLongAfterKickoff: TMatch[];
}

/**
 * Splits the rows findPotentiallyLive handed back into the ones the poller should still act on and
 * the ones it has to abandon. Structurally typed on kickoffAt alone so it can be applied to any
 * shape carrying one, and order-preserving so the abandoned side reads as a stable log line.
 *
 * The boundary is inclusive: a kickoff exactly one window old still counts as worth polling. Future
 * kickoffs are kept too — findPotentiallyLive's under-way arm has no upper bound, so a fixture the
 * provider reports in play ahead of our stored kickoff time must not be mistaken for an abandoned
 * one.
 */
export function partitionMatchesByPollingAbandonmentWindow<TMatch extends { kickoffAt: Date }>(
  matches: TMatch[],
  now: Date,
): MatchPollingAbandonmentPartition<TMatch> {
  const earliestKickoffStillWorthPolling = resolveEarliestKickoffStillWorthPolling(now);
  const stillWithinPollingWindow: TMatch[] = [];
  const abandonedLongAfterKickoff: TMatch[] = [];
  for (const match of matches) {
    if (match.kickoffAt >= earliestKickoffStillWorthPolling) stillWithinPollingWindow.push(match);
    else abandonedLongAfterKickoff.push(match);
  }
  return { stillWithinPollingWindow, abandonedLongAfterKickoff };
}

/**
 * Whether a club's players are locked right now — "Match Locking" in fantasy_league_v1_design.txt:
 * a player locks individually at the exact kickoff of their club's match, regardless of how that
 * match later resolves, and stays locked even after it finishes.
 */
export function isClubLocked(club: string, matches: { homeClub: string; awayClub: string; kickoffAt: Date }[], now: Date): boolean {
  return matches.some((match) => (match.homeClub === club || match.awayClub === club) && match.kickoffAt <= now);
}

export interface GameweekMatchProgress {
  /** Matches whose contribution to this gameweek's scoring is settled: played to a result
   * (COMPLETED) or resolved without one (VOIDED). A postponed fixture is deliberately *not*
   * counted here even though it no longer blocks the round — it has not been played, and progress
   * copy that counted it as played would simply be untrue. */
  finalizedMatchCount: number;
  totalMatchCount: number;
  /** True once no fixture is still holding this gameweek open — the same condition the worker
   * checks before it closes the gameweek, awards free transfers and writes final standings, so UI
   * copy about when scores appear stays true to what actually gates them. Because a POSTPONED
   * fixture does not block (MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION), this can be true
   * while finalizedMatchCount is short of totalMatchCount. */
  isGameweekReadyToClose: boolean;
}

/**
 * How far through its fixtures a gameweek is, and whether anything is still holding it open. The
 * "still holding it open" half reads the shared blocking-status rule rather than restating one, so
 * this and gameweeksRepository.hasEveryMatchStoppedBlockingGameweekCompletion cannot drift into
 * telling managers the round is unfinished while the worker has already closed and paid it. Takes a
 * structural subset of Match so the frontend can pass the summaries it gets from
 * GET /gameweeks/current, whose dates arrive as strings.
 */
export function summarizeGameweekMatchProgress(matches: { status: MatchStatus }[]): GameweekMatchProgress {
  const finalizedMatchCount = matches.filter(
    (match) => match.status === "COMPLETED" || match.status === "VOIDED",
  ).length;
  const matchesStillBlockingCompletionCount = matches.filter((match) =>
    MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION.includes(match.status),
  ).length;
  return {
    finalizedMatchCount,
    totalMatchCount: matches.length,
    isGameweekReadyToClose: matches.length > 0 && matchesStillBlockingCompletionCount === 0,
  };
}
