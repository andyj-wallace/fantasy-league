# Integration Test Gaps

A register of behaviour that **no automated test currently executes against a real database**,
why each gap exists, and what it would take to close it.

Started 2026-08-23, after the paid-transfer penalty bug (`transfers.points_cost` was written,
displayed, and never read by the scoring path). That bug survived a 349-test suite because every
test that could have caught it mocks the repository layer away. This doc exists so the next one
is found on a list instead of by accident.

---

## Why the blind spot exists

It is deliberate, and worth preserving. Per `CLAUDE.md`, the vitest suite is **pure**: it mocks
the `db/repositories` barrel, needs no Postgres, and runs in ~3s. That is why it gets run on every
change. Making it depend on a live database would make it slower and flakier, and it would get run
less — a bad trade.

The cost of that trade is precise and worth stating plainly:

> **Anything that lives below the repository barrel is invisible to `npm run test`.**
> Raw SQL, column mappings, migrations, constraints, defaults, and transaction behaviour are all
> mocked out. A repository function can be deleted entirely and most unit tests still pass.

This doc tracks what falls into that hole. It is not an argument for changing the unit suite.

---

## What each coverage tier actually reaches

| Tier | Command | Reaches | Does **not** reach |
|---|---|---|---|
| Unit (pure) | `npm run test` | Domain logic, workers, handlers — 453 tests / 52 files (2026-08-26) | Any SQL, any schema constraint, any migration — **except** `src/db/repositories/gameweeks.test.ts`, which asserts generated SQL via Drizzle's `.toSQL()` |
| Seed scripts | `npm run seed:mock`, `npm run seed:match-stats` | Real DB writes; `seedMatchStats` asserts hand-computed totals | Only the paths its fixed scenario happens to touch |
| Recorded smoke | `npm run smoke:recorded` | Full pipeline on a throwaway `<dev>_smoke` DB, real workers, real browser, 6 checkpoints | Only the one scripted gameweek scenario |

The recorded smoke suite is the strongest asset here and the natural home for most gaps below —
it already provisions its own database, drives the real import/scoring pipeline, and asserts
hand-computed final standings.

---

## The gap register

Priority reflects **blast radius × likelihood of silent breakage**, not effort.

### P1 — Paid transfer penalty has no automated real-DB coverage

The scoring deduction added 2026-08-23. Unit tests cover it well (12 tests), but they mock
`sumTransferPointsCostByTeamForGameweek`, so its `coalesce(sum(...), 0)::int` never ran in CI.

The recorded smoke suite does make transfers — but **both are free**. Alpha's banked count moves
`2 → 1` at checkpoint B and `3 → 2` at checkpoint D (`EXPECTED_BANKED_TRANSFERS`), so
`points_cost` is 0 for both and the deduction is never exercised. The suite's hand-computed
standings are therefore *unaffected* by the penalty change — which is good news for the fix, and
bad news as coverage.

- **Verified manually 2026-08-23** against a throwaway database: deduction, stacking, free
  transfers, absent-team fallback, negative totals, leaderboard propagation, and re-run
  idempotency. All passed. See the recipe below — that check was deleted after running.
- **To close:** extend the recorded smoke scenario so one team exhausts its banked transfers and
  makes a paid one, then assert the -10 in final standings. This is the single highest-value
  addition on this list, because it also locks in that the penalty reaches the leaderboard.

### P1 — The 8-transfer banked cap is untested at every level

`MAX_BANKED_FREE_TRANSFER_COUNT = 8` is enforced in SQL, not in TypeScript:

```ts
bankedFreeTransferCount: sql`LEAST(${teams.bankedFreeTransferCount} + ${amount}, ${MAX_BANKED_FREE_TRANSFER_COUNT})`
```

- Neither writer has a co-located unit test — `awardGameweekFreeTransfers.ts` and
  `awardPostponedMatchTransfers.ts` are both in the no-test list.
- The recorded smoke tops out at 4 (Alpha) and 6 (Bravo), so it never reaches the cap either.
- The design doc calls this cap out twice, including the rule that postponed-match awards *stack*
  with the regular allowance but remain bounded by it — the exact interaction most likely to
  break.
- **To close:** a unit test per worker would catch the arithmetic; the cap itself needs a real-DB
  assertion because `LEAST` is SQL.

### P2 — 13 raw SQL fragments never executed by CI

Every one is mocked away by the unit suite. Count by file:

| File | Fragments | What they do |
|---|---|---|
| `playerScores.ts` | 8 | `didAppear` jsonb extraction, `count/sum/bool_or` aggregate, 4x `excluded.*` upsert |
| `teams.ts` | 2 | banked-transfer `LEAST` cap, soft-delete `removedAt is not null` guard |
| `transfers.ts` | 1 | paid-transfer aggregate (manually verified 2026-08-23) |
| `gameweeks.ts` | 1 | `LEAST` deadline coalescing |
| `matches.ts` | 1 | `make_interval` kickoff shifting |

The `playerScores` upsert conflict path is the most concerning: it only fires on **re-import of an
already-scored match**, which is precisely the live-poll reconciliation path added 2026-08-22.

### P3 — Migrations are proven only as often as someone runs the smoke suite

Better than expected. `runRecordedSmokeTest.ts:32` already runs `drizzle-kit migrate` against a
freshly dropped-and-recreated database, so **every `npm run smoke:recorded` is a full
migrate-from-zero test.** There is no gap in the mechanism.

The gap is cadence: nothing runs it automatically, so a broken migration is caught whenever
someone next happens to run the suite — which may be after the commit has landed.

- Migration `0012` was additionally applied to a throwaway DB on 2026-08-23 and verified to add
  `team_scores.transfer_points_cost` correctly.
- **To close:** run `npm run smoke:recorded` as a pre-deploy gate, or in CI. No new test needed —
  only a trigger for one that already exists.

### P3 — Schema constraints are undocumented until they fire

Writing the 2026-08-23 verification fixture hit
`teams_league_id_user_id_idx` (one team per user per league) only at runtime. The constraint is
correct and doing its job; the point is that constraint behaviour is knowable *only* by talking to
Postgres. Any test asserting a rejection — duplicate joins, FK violations, NOT NULL defaults —
must be an integration test by definition.

### P3 — `pg` deprecation warning in `updateStandings`

Observed during the 2026-08-23 run:

```
DeprecationWarning: Calling client.query() when the client is already executing a query is
deprecated and will be removed in pg@9.0
```

Triggered by `Promise.all(teams.map(...))` issuing parallel queries on a single transaction
client. Pre-existing, unrelated to the transfer fix, and harmless today — but it becomes a hard
failure on a `pg` major upgrade, and only a real-DB run surfaces it.

---

## Recipe: ad-hoc integration check

Used on 2026-08-23 to verify the transfer penalty. Roughly 5 minutes, touches nothing of yours.

```bash
docker compose up -d postgres

# An isolated database — never the dev or _smoke ones.
docker exec fantasy-league-postgres-1 \
  psql -U user -d postgres -c 'CREATE DATABASE fantasy_league_scratch;'

# Applying migrations here also proves they apply.
DATABASE_URL='postgres://user:password@localhost:5432/fantasy_league_scratch' \
  npx drizzle-kit migrate

# Put the script in artifacts/ — it is gitignored, and relative imports stay simple.
DATABASE_URL='postgres://user:password@localhost:5432/fantasy_league_scratch' \
  npx tsx artifacts/yourCheck.ts

# Clean up.
docker exec fantasy-league-postgres-1 \
  psql -U user -d postgres -c 'DROP DATABASE fantasy_league_scratch;'
rm -rf artifacts/yourCheck.ts
```

Two things worth knowing when writing the fixture:

- `player_scores.breakdown` needs `{"appearancePoints": 1}` for `didAppear` to be true — the
  captain-bonus fallback depends on it.
- Each team needs its **own** user, per the unique index above.

---

## Log

- **2026-08-23** — Doc created. Transfer penalty (P1) verified manually against a throwaway
  database: 9 assertions covering deduction, stacking, free transfers, absent-team fallback,
  negative totals, leaderboard propagation, and 3-run idempotency — all passed. Migration `0012`
  confirmed to apply cleanly. Confirmed the recorded smoke suite makes only *free* transfers, so
  the penalty change does not alter its hand-computed standings.
