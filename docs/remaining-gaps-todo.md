# Remaining gaps TODO

Updated 2026-07-01. The skeleton (layers 1–4 of the build order in
[`Fantasy League Build Approach.txt`](Fantasy%20League%20Build%20Approach.txt)) is in place and
most of it is real, working logic — not mocks. This list tracks what's left, grouped by
milestone. **Complete each milestone fully before starting the next.**

## Milestone map

| # | Item | Milestone | Status |
|---|---|---|---|
| 1 | Football data provider — first live run | M1 | **done** |
| 4 | Monthly price-update formula | M1 | **done** |
| 8 | Locking — API-level enforcement (P0) | M1 | **done** — all endpoints (makeTransfer, setTeamRoster, setTeamLineup) guarded |
| 9 | Race conditions P0 (transfer transaction, banked-transfer increment) | M1 | **done** |
| 9 | Race condition P1 — playerScores unique constraint + upsert | M1 | **done** |
| 9 | Strategy 1 seed script (seedMatchStats.ts) | M1 | **done** |
| 3 | Auth — real credentials (Cognito) + read-endpoint gating | M2 | open |
| 7 | Test suite (vitest, scoring engine first) | M2 | open |
| 9 | Race conditions P1 (duplicate joins) + P2 | M2 | open |
| 1 | Confirmation-pass cascade design decision | M2 | open |
| 8 | Roster diff semantics for locking (open product question) | M2 | open |
| 6 | Full player roster hydration (paid API-Football plan) | M3 | open |
| — | Admin tools, deployment infra, monitoring, beta testing | M3 | open |
| 10 | Bonus Points — game state goals (winning/equalizing/losing) | M5 | open — design TBD |

## Dev testing strategy — build order (do not skip ahead)

**[done] Strategy 1 — `src/db/seedMatchStats.ts` (`npm run seed:match-stats`)**
Inserts 6 synthetic players, a completed Arsenal 2-0 Chelsea match, and 6 `PlayerMatchStat` rows,
then runs `calculatePlayerScores` → `calculateTeamScores` → `updateStandings` in-process and
asserts all 11 hand-computed expected values (6 player scores, 2 team scores including captain
2× bonus, 2 standings ranks). All assertions pass. Zero API calls. Verified 2026-06-30. This is
the foundation for the vitest suite in Milestone 2 — port the assertions directly into unit tests
once vitest is wired up.

**Strategy 2 — Recorded fixture files + `OfflineFootballDataProvider` (one-time ~4-6 API calls,
then zero forever)**
Spend a handful of quota requests once to capture real response bodies from `/fixtures`,
`/fixtures/players`, `/fixtures/events`, and `/injuries` (use a completed 2024 season fixture).
Save them as JSON files in `src/workers/__fixtures__/`. Write an `OfflineFootballDataProvider`
implementing `FootballDataProvider` that reads from those files. Wire it into local dev for
import-layer validation (importMatchData, status mapping, own-goal attribution) and as vitest
regression fixtures in Milestone 2. **Do this second**, once scoring is validated via Strategy 1.

**Strategy 3 — Single targeted live smoke test (≤10 real API calls, one-time only)**
The only run that actually hits the live API-Football account. Confirms auth header, base URL,
error handling, and that real data flows through the full pipeline end-to-end. **Do this last**
— reserved for the pre-Milestone 3 launch check. Never run in CI, never routine dev.

---

## [M0 — COMPLETED] 0. Local dev wiring

`dev:api`/`dev:worker`/`dev:worker:price-update` never loaded `.env` (only `drizzle-kit`
auto-loads it for `db:generate`/`db:migrate`), so `DATABASE_URL` was `undefined` at runtime and
`pg` failed the SASL handshake on the very first query — the API/worker entrypoints were
unusable locally even though migrations worked fine. Fixed by adding the `dotenv` dependency and
`import "dotenv/config"` as the first line of `src/api/index.ts`, `src/workers/index.ts`, and
`src/workers/monthlyPriceUpdateIndex.ts`. Verified end-to-end against local Postgres: login →
create league → join league → search players → standings all round-trip correctly through
`npm run dev:api`, and all 7 `npm run dev:web` pages render.

## [M1 — COMPLETED] 1. Football data provider (layer 5 — implementation + live run validated)

`src/workers/apiFootballProvider.ts` is a real client against API-Football
(`v3.football.api-sports.io`), wired all the way through `runWorkerCycle` →
`importMatchData`/`importPlayerRoster`/`importPlayerAvailability` →
`calculatePlayerScores`/`calculateTeamScores`/`updateStandings`. `footballDataProvider.ts` is now
provider-shaped DTOs + a capability interface; `StubFootballDataProvider` still backs the default
param everywhere so nothing hits the network unless a real provider is explicitly passed in
(`index.ts`/`handler.ts` do this via `createFootballDataProviderFromEnv()`).

What it does:
- `fetchSeasonFixtures`/`fetchLiveFixtures` (`GET /fixtures`) feed `importMatchData`, which
  bootstraps `Gameweek` rows from the fixture round label, maps API-Football's status codes onto
  `MatchStatus` (`footballMatchStatusMapping.ts`), and upserts `Match` rows keyed by the new
  `externalId` column.
- `fetchFixturePlayerStats` (`GET /fixtures/players` + `/fixtures/events`) resolves provider
  player IDs to internal `Player` rows via the new `players.externalId` column.
- `importPlayerRoster.ts` (`GET /teams` once, then `GET /players/squads?team=` per club — confirmed
  against real sample responses; no pagination, position comes back as a full word directly per
  player) is the only path that creates `Player` rows — none existed before. New players get a
  flat per-position placeholder price (`DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION` in
  `domain/constants.ts`). Costs ~21 calls/run, so it's gated weekly, not daily.
- `importPlayerAvailability.ts` (`GET /injuries`) populates `availabilityStatus`/`availabilityReason`.
- `liveMatchPolling.ts` implements the adaptive cadence formula from `polling-budget.md`, and
  `confirmationPasses.ts` implements the ~45-60min-after-completion VAR-correction re-poll. Both
  are gated through a new singleton `providerPollState` table so the cadence math survives both
  Lambda's stateless invocations and local process restarts.

Validation (completed 2026-07-01):
- [x] Run `npm run db:migrate` (adds `players.externalId`, `matches.externalId`,
      `provider_poll_state`, `pending_confirmation_passes` — migrations `0003`, `0004`, `0005`)
- [x] Endpoint response shapes spot-checked against real sample responses for
      `fixtures/players`, `fixtures` (`live=all`), `fixtures/events` (including own-goal samples),
      `injuries`, `players/squads`, and `teams`.
- [x] `npm run db:migrate` applied cleanly against local Postgres.
- [x] Live worker cycle run (`npm run dev:worker` with real `DATABASE_URL` and `FOOTBALL_DATA_API_KEY`)
      confirmed: roster import succeeds, fixture discovery succeeds, locking logic validates correctly,
      scoring cascade (calculatePlayerScores → calculateTeamScores → updateStandings) produces correct
      results. Tested against 2024 season (API-Football's current populated season).

Known, deliberate boundary — open design question for M2:
- [ ] A confirmation-pass correction recalculates that Match's `PlayerScore` rows but does **not**
      cascade into re-running `calculateTeamScores`/`updateStandings` if the gameweek has already
      been marked `COMPLETED`. Re-opening finalized standings on a late correction is a real
      product question (do standings retroactively change days later?) that wasn't asked here —
      flagging as a follow-up rather than silently deciding it. **(Decision needed in M2.)**

## [M0 — COMPLETED] 2. Squad composition validation

`src/domain/squadComposition.ts` now enforces every rule from `fantasy_league_v1_design.txt`'s
"Squads" section: `validateSquadComposition` (exactly 16 players, total cost ≤£110M, exactly 2
goalkeepers, max 3 players per club) and `deriveStartingFormation` (the starting XI's actual
DEF-MID-FWD shape must match one of the 7 named formations — not just fall within the
3-5/2-5/1-3 ranges, since e.g. a 5-2-3 split is in-range on every count but isn't one of the 7
valid formations).

Wired into:
- `setTeamRoster.ts` — validates the full 16 plus the chosen starting 11's shape.
- `setTeamLineup.ts` — requires the submitted `formation` to equal the *actual* derived shape of
  the team's current starters, not just be one of the 7 valid strings.
- `makeTransfer.ts` — re-validates the whole squad and the starting XI's shape after the swap
  (a transfer can change goalkeeper count, club balance, or formation shape; budget was already
  checked here, now squad-wide rules are too).

Smoke-tested against local Postgres: confirmed rejections for wrong squad size, over-budget
squads, wrong goalkeeper count, and a formation claim that didn't match the actual starting XI;
confirmed a properly composed squad (2 GK, valid 4-4-2 shape, no club over 3, under budget)
saves successfully.

Known, deliberate boundary: a transfer that changes the starting XI's shape doesn't auto-update
the Team's stored `formation` field — it can go stale until `setTeamLineup` is called again with
the new shape. Not auto-correcting it without an explicit user choice seemed right, but flagging
since it means `team.formation` and the literal roster can briefly disagree after a transfer.

## [M2] 3. Auth is a stub, but now an extensible one with real ownership checks

`login.ts` still does no real credential check (email+displayName creates-or-fetches a user) —
but that logic now lives behind `src/api/auth/authProvider.ts`'s `AuthProvider` interface,
implemented today by `StubAuthProvider`. Every handler calls `requireAuth(...)` and gets a
verified `AuthSession`, not a client-supplied ID — closing what was actually the bigger gap: every
mutating endpoint (`createLeague`, `joinLeague`, `setTeamRoster`, `setTeamLineup`, `makeTransfer`,
`updateLeague`, `regenerateInviteCode`, `removeManager`) previously trusted whatever
userId/teamId/leagueId was in the request with zero ownership check — anyone who knew a team's
UUID could edit it. Now ownership (`team.userId === session.userId`) or commissioner-ship
(`league.commissionerUserId === session.userId`) is checked server-side before any mutation.
Smoke-tested with two real users against local Postgres: cross-user mutation attempts correctly
403, missing/invalid tokens correctly 401, the actual owner/commissioner correctly 200s.

Swapping in AWS Cognito later (per the user's stated plan, closer to deployment) means writing a
`CognitoAuthProvider implements AuthProvider` and branching to it in
`createAuthProviderFromEnv.ts` — no handler changes needed, since they only ever see the
`AuthSession` the provider hands back, never a provider-specific token format.

Known, deliberate boundary (scope was "mutations only" for this pass):
- [ ] Read endpoints (`getTeam`, `getAvailableTransfers`, `getLeague`, `getPlayer`,
      `searchPlayers`, `getLeagueStandings`) are **not** gated behind `requireAuth` — they still
      work with no token at all. Four of them back Next.js server components
      (squad-builder/transfers/leaderboard/player-detail pages) that `fetch` server-side with no
      access to the client's `localStorage` token; gating those would mean either converting them
      to client components or introducing cookie-based sessions — a separate decision, not
      decided here. **(Resolve in M2.)**
- [ ] Still no real credential check (password/magic-link/OAuth) — `StubAuthProvider.login`
      creates-or-fetches by email alone, same as before. Replacing this is exactly the Cognito
      swap mentioned above. **(Resolve in M2.)**

## [M1 — COMPLETED] 4. Monthly price update formula

`runMonthlyPriceUpdate.ts` is now a complete, validated formula combining three market signals:

**Formula** (src/domain/playerPricing.ts, completed 2026-07-01):
- **50% Recent Form** — average points over the player's last 5 scored matches, normalized to a 15-point ceiling
- **25% Transfer Activity** — net transfers (in minus out) over the last 30 days, expressed as a fraction of total teams (centered so zero net = neutral)
- **25% Ownership** — fraction of all teams currently rostering the player

**Fallback:** If a player has fewer than 3 scored matches (new or rarely-playing player), the form weight redistributes equally to transfer activity and ownership rather than penalizing thin playing history.

**Implementation:** `runMonthlyPriceUpdate.ts` aggregates player scores, transfer volumes, and ownership counts, then recalculates and atomically persists new prices. All constants (MIN_PRICE, MAX_PRICE, FORM_WINDOW, FORM_CEILING, MIN_MATCHES_FOR_FORM) and weights are named in the domain layer for independent tuning.

**Tested:** Formula produces reasonable price movements; constants are tunable without changing the worker orchestration logic.

## [M0 — COMPLETED] 5. Frontend user flow — sign up/login → create/join → squad builder

Followed the natural flow end to end (login → home → create/join league → squad builder) and
fixed the structural/functional gaps, without any styling/CSS investment (per explicit
instruction — plain HTML only):
- `createLeague` now also creates the commissioner's own `Team` in the same call (was previously
  league-only, which meant the creator had to immediately call `/leagues/join` with their own
  invite code just to get a team) — response shape is now `{ league, team }`, matching what
  `joinLeague` already returned.
- New `GET /me/teams` endpoint (`teamsRepository.findWithLeagueByUserId`) — every Team a user
  holds, joined with its League — powers a real logged-in home page.
- `src/app/page.tsx` is a real home page now, not a static link list: logged-out users see a
  login prompt; logged-in users see their leagues/teams (with links into squad-builder/transfers/
  leaderboard) fetched from `/me/teams`, plus create/join links and a log-out button.
- `login.tsx`/`leagues/create/page.tsx`/`leagues/join/page.tsx` redirect into a real next step on
  success instead of dumping the raw response: login → `/`; create/join league → straight into
  `/teams/{team.id}/squad-builder`. Errors render as plain readable text instead of raw JSON.
- Squad builder, transfers, leaderboard (folded into league page), and player detail screens are
  all fully rendered — no JSON-dump screens remain.

Smoke-tested end to end against local Postgres via curl: login → create league (team auto-created)
→ `/me/teams` → set a real 16-man roster (2 GK, 5 DEF, 5 MID, 4 FWD, no club over 3, £103.5M of
£110M) → set a 4-4-2 lineup with captain/VC → squad-builder page renders the readable summary
correctly (verified the actual rendered HTML, not just a 200 status). Also confirmed a second
user joining via invite code gets their own team the same way.

Login/signup is deliberately kept as **one combined screen** (per explicit instruction) — an
unknown email creates an account, a known one logs in; no separate sign-up flow exists or is
planned for V1.

## [M3] 6. Full player roster hydration is blocked on the free API-Football plan

Built `fetchAllPlayersForSeason()` (paginated `GET /players?league&season&page`) and
`importAllPlayersForSeason.ts` alongside the existing squad-based `fetchPlayerRoster()`/
`importPlayerRoster.ts`, plus a one-time manual entrypoint
(`src/workers/hydratePlayerRosterOnce.ts`, `npm run hydrate:roster`) to populate `Player` rows
before a season starts. Validated against the live API (season `2024`, now the
`createFootballDataProviderFromEnv()` default) — real names/clubs/positions came through
correctly via `mapProviderPositionLabel` (fixed a wrong assumption along the way: `/players`'
`games.position` is the same full-word convention as `/players/squads`, not a single-letter
code).

Two free-tier constraints mean neither path can deliver a complete ~550-player Premier League
roster today:
- `/players` caps the `page` param at 3 on the free plan (`fetchAllPlayersForSeason` now catches
  this and returns a partial result with a warning instead of throwing) — only ~59 players per
  run.
- `/players/squads` has no page cap but needs ~20 back-to-back calls (one per club) with no
  league-wide equivalent; even at a 5s inter-request delay (`FOOTBALL_DATA_REQUEST_DELAY_MS`)
  this was still 429ing on the free plan's per-minute limit.

Deliberate scope decision for now: `hydratePlayerRosterOnce.ts` calls only
`importAllPlayersForSeason` and skips `importPlayerRoster` entirely — good enough to build and
validate the squad-builder flow against ~59 real players in dev, not worth fighting the free
tier's rate limit for full coverage.
- [ ] Once on a paid API-Football plan: re-add `importPlayerRoster` to
      `hydratePlayerRosterOnce.ts` for full-roster completeness, and tune
      `FOOTBALL_DATA_REQUEST_DELAY_MS` down to match the higher rate limit.
- [ ] Revisit `FOOTBALL_DATA_SEASON_YEAR` (currently defaulted to `2024`) once the real upcoming
      season's data is confirmed populated on API-Football's side.

## [M2] 7. No test suite

No jest/vitest/test files anywhere in `src/`. Per `ROADMAP.txt`, the scoring engine is the
highest-risk area (mid-match injuries, captain not playing, postponed fixtures) and is where
test coverage would pay off most. The Strategy 1 seed script (dev testing strategy above) is the
natural starting point — convert it directly into vitest tests once it exists.
- [ ] Add vitest (fits the Next.js + tsx stack already in use)
- [ ] Cover `calculatePlayerScores`, `calculateTeamScores` (captain/VC fallback), and
      `updateStandings` (tiebreaker order) first
- [ ] Wire Strategy 2 recorded fixture files as import-layer regression tests

## [M1 — COMPLETED] 8. Locking — API-level enforcement (P0)

**Decision made** (completed 2026-07-01): Unchanged status on locked players is allowed (idempotent save), but any change to starting/benching/captaincy status is rejected while locked.

`isClubLocked()` (`src/domain/match.ts`) matches the design spec ("Players lock individually at exact kickoff of their match ... Locked players cannot be transferred, benched, captained, or vice-captained").

**Implementation:**

- [x] `makeTransfer.ts` — `isClubLocked` guards both outgoing and incoming player; returns 400 with player name and reason. Done 2026-06-30.
- [x] `setTeamRoster.ts` (lines 44–71) — Detects if any matches have kicked off this gameweek, then:
      - Rejects removed players if locked
      - Rejects players whose starting/bench status is changing if locked
      - Allows idempotent re-saves with unchanged status (permits defensive saves without losing work)
      - Done 2026-07-01.
- [x] `setTeamLineup.ts` (lines 43–59) — Checks if captain or vice-captain assignments are **changing** to a locked player; rejects if so.
      Allows idempotent re-saves of the same captain/VC without locked-player rejection. Done 2026-07-01.

## [M1 → M2] 9. Race conditions (found 2026-06-30)

P-level key: **P0** = realistic under normal usage, causes silent data/financial corruption.
**P1** = realistic under normal system operation (worker concurrency), causes data corruption.
**P2** = narrow timing window or self-healing, lower blast radius.

Fix P0 items in M1. Fix P1 and P2 items in M2.

- [x] **P0 / M1 — done 2026-06-30** — `makeTransfer.ts`: wrapped in `db.transaction()` with a
      `SELECT ... FOR UPDATE` re-read of the team row inside the transaction (via
      `teamsRepository.findByIdForUpdate`). Recomputes budget and banked-transfer count from
      the locked row; added the previously missing budget-negative check. `DbOrTx` type
      threaded through `replaceRosterSlots`, `updateAfterTransfer`, and `transfersRepository.insert`
      so all three writes participate in the same transaction.
- [x] **P0 / M1 — done 2026-06-30** — `teams.ts: incrementBankedFreeTransferCount`: replaced
      SELECT-then-UPDATE with a single atomic
      `UPDATE teams SET banked_free_transfer_count = LEAST(banked_free_transfer_count + $1, $2)`.
      No read, no race window.
- [x] **P1 / M1 — done 2026-06-30** — `playerScores` schema: unique index on `(player_id, match_id)`
      added (migration `0004_high_psylocke.sql`, applied locally). `replaceForMatch` switched to
      upsert (`ON CONFLICT (player_id, match_id) DO UPDATE`). Confirmation-pass re-poll and
      regular score calculation can now run concurrently without corrupting or duplicating rows.
- [ ] **P1 / M2** — `joinLeague.ts` / `teams` schema: no unique constraint on `(leagueId,
      userId)`, no existing-team check before insert. A double-submit creates two `Team` rows for
      one manager in one league, corrupting standings/leaderboard queries downstream. Fix: add
      `UNIQUE(league_id, user_id)` to the `teams` table, plus an upsert-or-409 check in the
      handler.
- [ ] **P2 / M2** — `providerPollState.ts: getOrCreate`: SELECT-then-INSERT, no atomicity.
      Concurrent worker-cycle cold starts (e.g. overlapping Lambda retries) can both see "no row
      yet" and both try to insert, one fails or state gets overwritten. Fix:
      `INSERT ... ON CONFLICT DO NOTHING` then re-`SELECT`.
- [ ] **P2 / M2** — `updateStandings.ts`: reads all teams' budgets/rosters up front, then
      processes them sequentially; a transfer committing mid-loop is read as stale for whichever
      team hasn't been processed yet. Self-heals on the next standings recalculation, but produces
      a wrong tiebreaker stat (`totalSpentInMillions`) in the meantime. Fix: wrap the read+compute
      block in a transaction with `REPEATABLE READ`, or snapshot all reads at one point in time.

## [M5] 10. Bonus Points — Game State Goals

Goals that change the match outcome carry extra fantasy points (positive or negative) on top of
standard scoring. See `docs/fantasy_league_v1_design.txt` → "Bonus Points — Game State Goals"
for the full rule definition and `ROADMAP.txt` → Milestone 5 for the implementation task list.

**Framework (fixed):**

  Winning goal — scorer + assister of the decisive winning goal: heavy bonus (value TBD)
  Equalizing goal — scorer + assister of any goal that ties a deficit: heavy bonus (value TBD)
  Losing goal — GKs/DEFs of conceding team + own-goal scorers, for the decisive losing goal:
               heavy penalty (value TBD)

  Timing multiplier on the bonus/penalty (not on base event points):
    0–75 min:   1.0×    76–80 min:  1.2×    81–85 min:  1.6×
    86–90 min:  2.0×    90+ min:    2.5×

**Open design decisions (must resolve before any implementation):**
- [ ] Exact base bonus/penalty values for each of the three scenarios
- [x] "Equalizing goal" scope: ✅ only the final equalizer in a draw — mid-match ties subsequently broken do not qualify
- [ ] "Losing-goal" penalty scope: all GKs/DEFs on pitch at concession time, or starters only?
- [ ] Own-goal as decisive goal: scorer takes penalty; no assister; no positive bonus

**Implementation tasks (after design decisions):**
- [ ] Extend match event tracking to record `goal_minute` and compute `goal_type`
      (winning / equalizing / losing) post-match from score progression
- [ ] Add `applyGameStateBonus` step to `calculatePlayerScores` after base event scoring
- [ ] Add `goalMinuteToTimingMultiplier(minute: number): number` helper to `src/domain/`
- [ ] Update `seedMatchStats.ts` with game-state bonus scenarios and expected-value assertions
- [ ] vitest: 3 scenarios × 5 time brackets = 15 base test cases + own-goal edge cases
