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
| `AUTH_TOKEN_SECRET` | yes | HMAC key for the signed-token fallback auth provider |
| `AUTH_PROVIDER` | no | `cognito` = real credential check (the standard mode, local dev included); unset = passwordless signed-token fallback for offline work; `stub` = scripts/tests only |
| `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID` | no | the user pool the API verifies ID tokens against; read when `AUTH_PROVIDER=cognito` |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_APP_CLIENT_ID` | no | switches the frontend to the real handle+email+password login; pool/client ids are public by design |

### Logging in during development

With Cognito mode on (the standard `.env` setup), the login page is the real sign-up/sign-in
flow: pick a handle, verify your email with the emailed code, log in with handle **or** email.
Two dev conveniences:

- A user created before Cognito (or via the fallback provider) is **linked automatically** on
  first Cognito login with the same email — teams and leagues carry over.
- For throwaway test accounts with fake emails, confirm them from the CLI instead of an inbox:
  `aws cognito-idp admin-confirm-sign-up --user-pool-id <pool> --username <handle>` followed by
  `aws cognito-idp admin-update-user-attributes --user-pool-id <pool> --username <handle> --user-attributes Name=email_verified,Value=true`.

Real values belong only in your local `.env` (gitignored, never committed). `.env.example` is a
committed template — it should only ever hold placeholders for secret values, never the real
thing. Beyond local development (CI, staging, production), don't store secrets in files at all:
inject them as environment variables at deploy time via AWS Secrets Manager or SSM Parameter
Store.

## Frontend — the League Hub

The league page (`src/app/leagues/page.tsx`) is the **hub**: a signed-in user does almost
everything for a league without navigating away from it. Standings and fixtures render directly on
the page; the team's **Squad Builder**, **Transfers**, and any **player's details** open *in-place*
as overlays on top of it.

### How it's put together

Each screen is a chrome-free panel component that fetches its own data, so the *same* component
renders both inside a hub overlay and as its standalone page:

| Surface | Panel component | Standalone route (fallback) |
|---|---|---|
| Squad builder | `SquadBuilderPanel` | `/teams/squad-builder?teamId=` |
| Transfers | `TransfersPanel` | `/teams/transfers?teamId=` |
| Player details | `PlayerDetailPanel` | `/players?playerId=` |

`Overlay` (`src/app/components/Overlay.tsx`) is the one modal primitive — a centered `popup` for
small/read-only content and a slide-up `panel` for large interactive screens. It owns
Escape-to-close, backdrop-click, body-scroll lock, focus restore, and a Tab focus trap. It's built
in the bespoke `globals.css` design system — **no component library, no Tailwind**.

### Overlay state lives in the URL (deep-linkable, Back-button-closable)

Opening a panel pushes a query param; closing pops history (so Back, Escape, and the ✕ all close
it). A player popup can **stack** on top of a panel by adding `playerId` while `panel` stays set:

- `…/leagues?leagueId=L&panel=squad&teamId=T` — squad overlay
- `…/leagues?leagueId=L&panel=transfers&teamId=T` — transfers overlay
- `…&playerId=P` — player popup, stacked over whichever panel is open

Player-name taps deep inside the squad builder (pitch, bench, discovery table) open the popup via
`PlayerDetailContext` — no callback threading. After a save or transfer, the panel calls
`onChanged`, which re-fetches the hub's team summary and standings so budget/status/rank update
live. **No per-request recalculation happens on the read path** — see the architecture doc.

### Standalone pages and the migration toggle (Option A)

The standalone routes are kept as deep-linkable fallbacks; the hub overlays and the standalone
pages **coexist**. Each standalone page runs through `useStandalonePageGate`
(`src/app/lib/standalonePageGate.ts`), which decides — render inline vs. hand off to the hub — by
first-match-wins precedence:

1. `?view=hub` / `?view=standalone` in the URL (per-visit override, wins on any device).
2. The visitor's saved choice in `localStorage` (set by the on-page "Open in league hub →" toggle)
   — honoured on any device once chosen.
3. The **device default**: the hub at desktop width, the standalone page on phones/narrow tablets.

The device default is decided by `hubIsDefaultForViewport()` — a `matchMedia` check against
`HUB_DEFAULT_MIN_WIDTH` (1024px, the same breakpoint where the league page gains its sidebar
layout). Desktops land on the hub overlays; small screens land on the standalone full pages, which
read better than large slide-up overlays there. Both experiences still coexist (Option A) — nothing
is deleted and deep links keep resolving. When a hand-off is chosen, the gate resolves the
equivalent hub URL (fetching to discover the team's `leagueId`, which the standalone URL doesn't
carry) and redirects; if it can't resolve one, it falls back to rendering standalone so no one is
stranded.

## Deployment (AWS)

Decided 2026-07-03:

- **Frontend** — static export (`next build` with `output: "export"`) to **S3 behind CloudFront**,
  not Amplify. Every page is a client component with the session token in `localStorage`, so
  there is no server-side rendering to host — Amplify's Next server adds cost and a second
  deployment system for nothing. CloudFront also serves the API under `/api/*` on the same
  distribution (API Gateway as a second origin), so the browser sees one domain and no CORS.
- **API and workers** — Lambda behind API Gateway plus scheduled worker Lambdas, with Postgres on
  RDS, all in one CDK/Serverless stack alongside the frontend hosting.
- The frontend is export-ready (done 2026-07-03): dynamic pages are addressed by query params
  (`/players?playerId=`, `/leagues?leagueId=`, `/teams/squad-builder?teamId=`,
  `/teams/transfers?teamId=`) because runtime UUIDs can't be enumerated at static-export build
  time, and `next.config.ts` sets `output: "export"` — `next build` emits the deployable site
  to `./out`.

## Football data polling budget

The football data provider caps us at 100 requests/day (excluding its free account/quota-status
endpoint). The worker's live-match polling cadence is computed from that budget rather than a
fixed interval. Summary:

| Scenario | Fixtures live | Interval | Total calls used |
|---|---|---|---|
| Busiest realistic (Sat 3pm blackout) | 7 | ~22 min | 94 / 100 |
| Typical day | 3 | ~9 min | 95 / 100 |
| Light day | 1 | ~3.5 min (floored ~5–10 min) | well under cap |
| Absolute floor (all 10 PL fixtures simultaneous — happens only on the final gameweek!) | 10 | ~37 min | 88 / 100 |
