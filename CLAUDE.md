# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

The project is scaffolded and Milestones 0–2 are complete. Stack: **Next.js + TypeScript** frontend (`src/app`), a **Node API** (`src/api`, handler-per-route, deployable to Lambda and served locally by `src/api/localServer.ts`), background **workers** (`src/workers`), and **PostgreSQL via Drizzle ORM** (`src/db`). Business logic lives in `src/domain`. The plain-text docs at the repo root remain the authoritative ruleset (see below).

Common commands (from `package.json`):
- `npm run test` / `npm run test:watch` — vitest unit tests (pure; mock the `db/repositories` barrel, no Postgres needed). Config in `vitest.config.ts`; tests are co-located as `src/**/*.test.ts`. Shared fixture builders: `src/testing/fixtures.ts`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run dev:api` / `dev:worker` / `dev:web` — local API, worker, and Next.js dev server.
- `npm run db:generate` / `db:migrate` — Drizzle migrations. Local Postgres via `docker-compose.yml`.
- `npm run deploy:*` — AWS deployment scripts (`scripts/`): `deploy:preflight`, `deploy:infra` (CDK) / `deploy:infra:cli` (plain CloudFormation), `deploy:migrate`, `deploy:frontend`, `deploy:smoke`, `deploy:all`, `db:tunnel`. `npm run destroy` prints the ordered teardown plan (only acts with `-- --execute`; never run it without Drew's explicit go-ahead). **Prod is live** — read `docs/deployment/DEPLOYMENT_RUNBOOK.md` before any deploy/ops work.
- Env lives in `.env` (gitignored; template in `.env.example`). The API needs `AUTH_TOKEN_SECRET` for the default signed-token auth provider.

Test coverage is currently focused on the scoring engine (`calculatePlayerScores`, `calculateTeamScores`, `updateStandings`), the auth layer, and the read handlers that feed the season-awareness UI (`getCurrentGameweek`, `getLeagueStandings`, `getAvailableTransfers`) — the highest-risk areas. There is still no lint tooling.

The frontend is no longer a plain-HTML skeleton: it has a bespoke design system (`src/app/globals.css` — no Tailwind), a global `AppHeader`, and a season-awareness layer (gameweek banner, fixtures on the league page, lock context, standings gameweek labels) fed by `GET /gameweeks/current`. The Strategy-2 smoke-test UX gaps are resolved — see `docs/testing/SMOKE_TEST_FINDINGS.md` (Resolution) and `docs/remaining-gaps-todo.md` item 11. The static export's flat-`.html` URLs are handled in production by the deployed CloudFront url-rewrite Function (`infra/lib/urlRewriteFunction.js`). Remaining work is tracked in `docs/remaining-gaps-todo.md` — deployment/ops hardening is item 13.

## What the docs are and where to look

The product and architecture are fully specified in plain-text docs at the repo root. Treat these as the source of truth for any implementation work — don't invent rules that contradict them.

- **`fantasy_league_v1_design.txt`** — the authoritative ruleset: league structure, squad/budget/formation rules, transfers, scoring point values, captaincy, tiebreakers, postponed-match handling. Read this first for any scoring or rules question.
- **`fantasy_league_user_flows_v1.txt`** — end-to-end user flows (create league → join → build squad → transfers → scoring → leaderboard), at the level of one bullet list per flow.
- **`fantasy_league_squad_builder_flow_v1.txt`** — the squad builder screen's flow in detail (player discovery, add/remove, validation, lineup, captaincy, save).
- **`Fantasy League Architecture.txt`** — the system architecture and the core "calculate once, store forever" pattern (see below). This is the most important doc for backend implementation decisions.
- **`Fantasy League MVP.txt`** — the current data model (entities) and screen list.
- **`ROADMAP.txt`** — phased build plan (milestones, time estimates) and a callout that the scoring engine — not the frontend or CRUD APIs — is where most effort goes, due to edge cases (injuries mid-match, captain not playing, postponed fixtures).
- **`Fantasy League V1 — Out of Scope.txt`** — explicitly deferred features (draft mode, chips, waiver wire, auto-subs in V1, etc.). Check this before adding scope.
- **`Fantasy League Build Approach.txt`** — the build methodology and ordering (see next section). Read this before writing any code.

## Build approach (from `Fantasy League Build Approach.txt`)

This project is being built **top-down, skeleton first**:

- Build order: (1) interfaces/skeleton connecting every component (frontend, API, workers, database, football data source) with stubs/mocks only → (2) database → (3) APIs → (4) backend workers → (5) football API data source integration. Don't jump ahead to real implementation in a later layer before the layer before it has its interfaces defined.
- It's fine — expected, even — for functions to be empty or return a hardcoded mock value before real logic is written. Don't feel obligated to implement behavior just because a function exists.
- Component interfaces are designed first and should follow SOLID principles, before behavior is fleshed out.
- **Code must be self-documenting.** Every function, variable, class, and interface name must fully spell out its purpose. This is a stated goal of the codebase, not a nice-to-have — prefer a longer, precise name over a short, vague one, and prefer a clear name over adding a comment to explain an unclear one.
- Once skeletons exist, functionality is fleshed out incrementally, one screen/user-flow at a time (per the flow docs above), not all at once.
- Hosting: AWS. V1 scale target: fewer than 1,000 `Player` (real footballer) records — this is a small-scale MVP, don't over-engineer for load it won't see.

## Architecture (from `Fantasy League Architecture.txt`)

Stack: **Next.js frontend → Node API → PostgreSQL**, plus a **separate worker process** driven by a cron scheduler. No Kafka/RabbitMQ/microservices/event bus for V1 — deliberately kept simple.

The core pattern is **precompute-and-store, never compute-on-read**:

1. A cron job polls the football data provider (e.g. football-data.org / api-football.com) every 1–5 minutes for match state changes.
2. On `MATCH_COMPLETED`, an importer stores raw per-player match stats (goals, assists, cards, saves, minutes).
3. A worker runs `calculatePlayerScores(matchId)` → writes to a `PlayerScore`-style table.
4. Another worker runs `calculateTeamScores(gameweek)` → writes to a `TeamScore`-style table (applies captain 2x, etc.).
5. `updateStandings()` writes the final ranked leaderboard to a `LeagueStanding`-style table.
6. The leaderboard API is then a flat `SELECT * FROM league_standings WHERE league_id = ?` — **no calculation happens on the read path.** Do not reintroduce per-request recalculation (e.g. recomputing every team's score when the leaderboard is opened) — that's the explicitly called-out anti-pattern in the architecture doc, and it doesn't scale past a trivial number of leagues/managers.

Other worker-triggering events: `GAMEWEEK_COMPLETED`, `PRICE_UPDATE_DAY`, `MATCH_POSTPONED`.

## Data model (from `Fantasy League MVP.txt`)

`League`, `User`, `Team` (one per user per league — holds the 16-man roster, formation, and captain/vice-captain directly; there is intentionally no separate `Squad` entity), `Player`, `Transfer`, `Gameweek`, `Match` (real-world fixture data), `PlayerMatchStat` (raw imported per-player stats), `PlayerScore`, `TeamScore`, `LeagueStanding` (the three precomputed tables described above).

## V1 scope decisions worth knowing before writing code

These are deliberate simplifications already settled — don't "fix" them without checking with the user first:

- **No automatic substitutions in V1.** Bench player points are added directly to the team's total score regardless of whether starters played. Auto-subs (replacing a non-playing starter with the highest-scoring eligible bench player) are deferred to V2.
- **Captain fallback is intentionally minimal.** If the captain doesn't play and the user hasn't reassigned captaincy before kickoff lock, the vice-captain gets the 2x bonus. If *neither* plays, there's no required fallback for V1 — left open/optional.
- **No clean sheet bonus for MID or FWD**, only GK/DEF.
- Postponed-match free transfers **stack** with the normal 2-per-gameweek allowance, but both are bounded by the same hard cap of 8 banked transfers.
- League join cutoff (Gameweek 25) is **system-wide**, not per-league.
