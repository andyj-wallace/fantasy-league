# fantasy-league
Football fantasy league game

## Local development

Prerequisites: Node.js, Docker.

### Start

```
npm install
docker compose up -d   # starts local Postgres on localhost:5432
cp .env.example .env   # only needed once
npm run db:migrate     # applies src/db/migrations to the database
npm run dev:api        # API server on http://localhost:3001, separate terminal (Ctrl+C to stop)
npm run dev:worker     # worker poll loop, separate terminal (Ctrl+C to stop)
npm run dev:worker:price-update  # monthly price update loop, separate terminal (Ctrl+C to stop)
npm run dev:web        # Next.js frontend on http://localhost:3000, separate terminal (Ctrl+C to stop)
```

### Stop

```
docker compose down    # stops and removes the Postgres container (data persists in its volume)
```

Add `-v` (`docker compose down -v`) to also delete the database volume and start fresh next time.

### Other commands

```
npm run typecheck      # tsc --noEmit
npm run db:generate    # generate a new migration after editing src/db/schema.ts
```

## Environment variables

| Variable | Secret? | Notes |
|---|---|---|
| `DATABASE_URL` | yes | local Postgres connection string |
| `NEXT_PUBLIC_API_BASE_URL` | no | bundled into client-side JS by Next.js — never put secrets here |
| `FOOTBALL_DATA_API_BASE_URL` | no | football data provider host, e.g. `https://v3.football.api-sports.io` |
| `FOOTBALL_DATA_API_KEY` | yes | football data provider key, read only by the worker process, never the frontend |

Real values belong only in your local `.env` (gitignored, never committed). `.env.example` is a
committed template — it should only ever hold placeholders for secret values, never the real
thing. Beyond local development (CI, staging, production), don't store secrets in files at all:
inject them as environment variables at deploy time via AWS Secrets Manager or SSM Parameter
Store.

## Deployment (AWS)

Decided 2026-07-03 (full rationale in
[`docs/Fantasy League Architecture.txt`](docs/Fantasy%20League%20Architecture.txt) → "Deployment (AWS)"):

- **Frontend** — static export (`next build` with `output: "export"`) to **S3 behind CloudFront**,
  not Amplify. Every page is a client component with the session token in `localStorage`, so
  there is no server-side rendering to host — Amplify's Next server adds cost and a second
  deployment system for nothing. CloudFront also serves the API under `/api/*` on the same
  distribution (API Gateway as a second origin), so the browser sees one domain and no CORS.
- **API and workers** — Lambda behind API Gateway plus scheduled worker Lambdas, with Postgres on
  RDS, all in one CDK/Serverless stack alongside the frontend hosting.
- Prerequisite before the frontend export works: the three dynamic UUID routes
  (`/players/[playerId]`, `/leagues/[leagueId]`, `/teams/[teamId]/…`) must switch to query-string
  params — runtime UUIDs can't be enumerated at static-export build time. Tracked under
  Milestone 3 in `ROADMAP.txt`.

## Football data polling budget

The football data provider caps us at 100 requests/day (excluding its free account/quota-status
endpoint). The worker's live-match polling cadence is computed from that budget rather than a
fixed interval — see [`docs/polling-budget.md`](docs/polling-budget.md) for the full back-of-envelope
breakdown. Summary:

| Scenario | Fixtures live | Interval | Total calls used |
|---|---|---|---|
| Busiest realistic (Sat 3pm blackout) | 7 | ~22 min | 94 / 100 |
| Typical day | 3 | ~9 min | 95 / 100 |
| Light day | 1 | ~3.5 min (floored ~5–10 min) | well under cap |
| Absolute floor (all 10 PL fixtures simultaneous — never happens) | 10 | ~37 min | 88 / 100 |
