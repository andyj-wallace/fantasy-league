# Testing & Smoke Test Documentation

This directory contains comprehensive testing reports and findings from MVP smoke testing.

## Recorded smoke suite (added 2026-07-13)

The manual click-through checklists below now have an automated, recorded counterpart:

```bash
npm run smoke:recorded        # requires the docker-compose Postgres to be running
```

It provisions a throwaway `<dev database>_smoke` database, seeds a two-team league
(`src/testing/recordedSmoke/gameweekLifecycleScenario.ts`), then plays one gameweek forward
through six checkpoints — matches spread Friday→Monday, per-club kickoff locks, transfers of
unlocked players (and a server-rejected locked one), a postponement with its banked-transfer
award, a **Gameweek 2 fixture that kicks off before Gameweek 1 ends** (must lock nobody for GW1),
and the completion cascade with hand-computed final standings (including the vice-captain 2x
fallback for a captain who never featured). Every state change flows through the real worker
pipeline (`importMatchData` → `processMatchDataChanges`) via a scripted `FootballDataProvider`;
there is no clock fake — event timestamps are shifted relative to real "now" per checkpoint.

It boots its own isolated servers (web :3100, API :3101, stub auth) and never touches the live
dev servers or database. Proof artifacts land in `artifacts/recorded-smoke/` (gitignored):
`report/index.html` (Playwright report with full-run video + trace) and `checkpoints/*.png`
(named per-checkpoint screenshots).

Findings the suite documents rather than fixes (all observed 2026-07-13):
- A POSTPONED match keeps the gameweek open indefinitely (`areAllMatchesCompleted` requires
  every match COMPLETED) — checkpoint E shows GW1 held open until the replay.
- Once a postponed match's *original* kickoff time passes (before the fixture is rescheduled),
  `isClubLocked` reads its clubs as locked again, with a "kicked off" label for a match that
  never kicked off — checkpoint E asserts this as-is.
- The roster table's layout is bistable: the transfer picker's `width: 100%` search input inside
  an auto-layout table cell means any style invalidation (e.g. the focus change caused by a
  mousedown) can re-solve column widths a few px differently, re-wrapping the lock-context text
  and shifting every row ~19px. A real click can land mousedown on Confirm and mouseup beside
  it, and the browser then targets the click at their common ancestor — silently swallowing the
  press. The suite works around it (`transferPlayerOut` dispatches the click event directly);
  a product fix would be `table-layout: fixed` or a fixed picker-column width.
- `calculateTeamScores` treats "captain played" as "a PlayerScore row exists": a captain
  reported by the provider with 0 minutes (an unused sub) still claims the 2x bonus — worth
  +0 — and suppresses the vice-captain fallback. The suite's captain has no stat line at all,
  which is what the design doc's fallback rule needs to fire.

One production bug it caught outright (fixed 2026-07-13): `matchesRepository.upsert` never
updated `kickoffAt` on re-import, so a postponed fixture's rescheduled date could never land —
and `isClubLocked` compares exactly that column. `kickoffAt` is now part of the upsert's
conflict-update set.

## Reports

### `SMOKE_TEST_FINDINGS.md` (PRIMARY)

Complete analysis of the critical path smoke test (league creation → squad builder → gameweek progression → scoring). Includes:

- **Test Data Summary**: 20 players, 6 gameweeks, seeded via `/src/testing/seed6GameweekSmokeTest.ts`
- **Squad Builder Findings**: What works, navigation issues, missing feedback
- **Season Visibility Gaps**: HIGH-PRIORITY UX gaps (gameweek indicators, match schedule, scoring messaging, transfer window timing)
- **Where Users Get Confused**: 5 detailed user confusion scenarios
- **All Missing Status Indicators**: Table of 9 critical missing UI elements
- **High-Priority Issues**: Season awareness gaps that must be addressed before launch

**Read this first** for an executive summary and prioritized gap list.

### `SEED_DATA_REPORT.md`

Detailed inventory of what was seeded:
- Player roster (names, positions, prices)
- Gameweek structure (6 weeks, dates, deadlines)
- Match statistics (goals, assists, cards, minutes, clean sheets)
- Price updates (GW3 changes)
- Injury events (Salah hamstring)
- Data quality validation

### `TEST_DATA_QUICK_START.md`

Step-by-step checklist for running the smoke test:
1. Seed the test data (`npx tsx src/testing/seed6GameweekSmokeTest.ts`)
2. Start the dev server
3. Follow the critical path (create league → squad → standings)
4. What to look for (navigation friction, missing context, unclear status)

### `OBSTACLES_AND_FINDINGS.md`

Issues encountered during test data generation and solutions:
- TypeScript type mismatches
- Missing API seed endpoints (workarounds documented)
- Gameweek status design decisions
- Recommendations for future infrastructure

### `FINAL_SUMMARY.txt`

Execution log and conclusions from the smoke testing session.

## How to Use These Docs

1. **First Time?** → Read `SMOKE_TEST_FINDINGS.md` for the executive summary
2. **Want to Run the Test?** → Follow `TEST_DATA_QUICK_START.md`
3. **Need Details on Data?** → Check `SEED_DATA_REPORT.md`
4. **Debugging Issues?** → See `OBSTACLES_AND_FINDINGS.md`
5. **Full Context?** → Read `FINAL_SUMMARY.txt`

## Key Findings

### High-Priority UX Gaps (Before Launch)
- [ ] **No gameweek indicator** anywhere in UI (users don't know which GW they're viewing)
- [ ] **No match schedule** visible (users blindsided by player locks)
- [ ] **No "scores calculated" messaging** (users unsure if points are current)
- [ ] **Transfer window timing opaque** (users confused about deadlines)
- [ ] **No "gameweek completed" notifications** (users miss transfer windows)

### Medium-Priority Issues (Good to Have)
- [ ] Share link discovery (hidden on league page)
- [ ] No "next steps" after squad save
- [ ] Budget not shown inline during player discovery
- [ ] No first-time user guidance
- [ ] Player availability status not visible

See `SMOKE_TEST_FINDINGS.md` for full details and code locations.

## Running Tests

```bash
# Seed the 6-gameweek season
npx tsx src/testing/seed6GameweekSmokeTest.ts

# Start dev server
npm run dev

# Open browser and test the critical path
# Follow TEST_DATA_QUICK_START.md for checklist
```
