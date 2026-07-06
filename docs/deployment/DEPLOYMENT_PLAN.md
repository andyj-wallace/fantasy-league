# Deployment Plan — AWS (M3)

Status: **spec / not yet implemented.** This is the implementation prompt for standing
up the production stack. Milestones 0–2 are complete; this closes the largest M3 gap.

## Goal

Deploy the existing app to AWS at the **lowest sensible cost with a properly
network-isolated database**, without rewriting application code. Scale target is a
deliberately small MVP (<1,000 player records, low concurrency).

The code is already deploy-ready:
- API handlers consume `APIGatewayProxyEvent` / return `APIGatewayProxyResult`, and
  `src/api/routes.ts` already dispatches method+path → **one thin adapter Lambda
  reuses the route table; no handler changes**.
- Workers are already `ScheduledHandler`s (`src/workers/handler.ts`,
  `src/workers/monthlyPriceUpdateHandler.ts`) → direct EventBridge targets.
- DB is a module-scope `pg.Pool` on `DATABASE_URL` (`src/db/client.ts`) → reused
  across warm invocations; only needs TLS config added.
- Frontend is `output: "export"` → static `./out` → pure S3 + CloudFront.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| IaC | **AWS CDK (TypeScript)** | Same language as repo; `NodejsFunction` auto-bundles via esbuild |
| CI/CD | **GitHub Actions** | Also closes the "no CI" gap (typecheck + vitest gate) |
| Frontend | **S3 (private, OAC) + CloudFront** | Static export; CloudFront free tier covers 1 TB/mo |
| URL rewrite | **CloudFront Function** | Extensionless `.html` rewrite; ~10× cheaper than Lambda@Edge |
| API | **API Gateway HTTP API → single router Lambda (ARM64)** | HTTP API ~70% cheaper than REST; one artifact, fewer cold starts |
| Workers | **2 EventBridge schedules → 2 Lambdas** | Existing `ScheduledHandler`s drop in |
| Database | **RDS Postgres `db.t4g.micro`, PRIVATE (VPC private subnets)** | Network-isolated; free tier yr 1, then ~$14/mo |
| Internet egress for VPC Lambdas | **fck-nat NAT instance (`t4g.nano`, ASG size 1)** | ~$3/mo vs ~$32/mo NAT Gateway; failure is invisible to users |
| Auth | **Existing Cognito pool `us-east-1_DBETCnAJP`, imported** | Already implemented + live-verified; free ≤50k MAU |
| Secrets | **SSM Parameter Store (SecureString)** | Free vs Secrets Manager's $0.40/secret/mo |
| Domain | **Default `*.cloudfront.net` URL** | Add custom domain (Route53 + ACM) later |

## Architecture

```
                 Internet
                    │
              CloudFront (one distribution, *.cloudfront.net)
              ├── default → S3 (private, OAC)           [static Next export]
              │      + CloudFront Function: /login → /login.html rewrite
              └── /api/* → API Gateway HTTP API → API Lambda ──┐
                                                               │
  Cognito pool (imported) ── JWKS verified offline in-Lambda   │
                                                               │
  EventBridge (rate 1–5 min) → Worker Lambda ─────────────┐    │
  EventBridge (monthly)      → Price-update Lambda ───┐    │    │
                                                      │    │    │
  ┌──────────────────────── VPC ──────────────────────┼────┼────┼──────────┐
  │  Public subnet (AZ-a):  fck-nat NAT instance (ASG size 1, static ENI)  │
  │        ▲ outbound internet for football API + Cognito JWKS + SSM        │
  │  Private subnets (AZ-a, AZ-b):                                          │
  │        • API Lambda, Worker Lambda, Price Lambda, Migration Lambda      │
  │        • RDS Postgres t4g.micro (no public IP, SG: VPC-only:5432)       │
  └────────────────────────────────────────────────────────────────────────┘
  SSM Parameter Store (SecureString): DATABASE_URL, AUTH_TOKEN_SECRET,
        FOOTBALL_DATA_API_KEY, COGNITO_* — read by Lambdas via NAT egress
```

## VPC / networking design (the crux)

- **VPC** with **2 AZs** (RDS requires a DB subnet group spanning ≥2 AZs even in
  single-AZ mode). Per AZ: one **public** subnet, one **private** subnet.
- **NAT instance (fck-nat)** in the AZ-a public subnet, in an **ASG of size 1** with a
  **static ENI** it reattaches on relaunch → self-heals in ~2–4 min if it dies. Both
  private subnets' route tables send `0.0.0.0/0` to it. Use the
  [`cdk-fck-nat`](https://github.com/AndrewGuenther/fck-nat) construct — it's a
  ~5-line swap for CDK's `NatProvider.gateway()`.
- **All Lambdas run in the private subnets.** VPC cold-start ENI penalty is negligible
  since AWS Hyperplane ENIs — do not treat it as a reason to avoid VPC.
- **RDS** in the private subnets, `publiclyAccessible: false`, SG allows `:5432` **only
  from the Lambda security group** (or the VPC CIDR). Enforce TLS.
- **Egress needs** routed via the NAT instance: worker → api-football.io; API →
  Cognito JWKS (`https://cognito-idp.us-east-1.amazonaws.com/.../jwks.json`, cached
  in-provider already); all Lambdas → SSM Parameter Store. No interface VPC endpoints
  (they'd be ~$7/mo each — NAT egress is cheaper at this scale).

## Naming conventions & tagging

Every resource name includes `fantasy-league` and the environment so resources are
self-describing in the console, in bills (cost allocation tags), and in logs. This is
a hard convention for this project — follow it exactly.

- **Pattern:** `fantasy-league-<env>-<resource>` where `<env>` ∈ `dev` | `staging` |
  `prod`. Example: `fantasy-league-prod-api`.
- **CDK stack:** `FantasyLeague-<Env>` (construct) / physical `fantasy-league-<env>`.
- **CDK construct IDs:** PascalCase (`FantasyLeagueVpc`); **physical names:** kebab-case
  (`fantasy-league-prod-vpc`). Set physical names explicitly — don't rely on CDK's
  auto-generated hashes for the resources below.

| Resource | Name |
|---|---|
| VPC | `fantasy-league-<env>-vpc` |
| NAT instance (fck-nat) | `fantasy-league-<env>-nat` |
| RDS instance | `fantasy-league-<env>-db` |
| DB security group | `fantasy-league-<env>-db-sg` |
| Lambda security group | `fantasy-league-<env>-lambda-sg` |
| NAT security group | `fantasy-league-<env>-nat-sg` |
| API Lambda | `fantasy-league-<env>-api` |
| Worker Lambda (match poll) | `fantasy-league-<env>-worker` |
| Price-update Lambda | `fantasy-league-<env>-price-update` |
| Migration Lambda | `fantasy-league-<env>-migrate` |
| HTTP API | `fantasy-league-<env>-http-api` |
| EventBridge rule (poll) | `fantasy-league-<env>-match-poll` |
| EventBridge rule (price) | `fantasy-league-<env>-price-update` |
| S3 web bucket | `fantasy-league-<env>-web-<account-id>` (buckets are globally unique) |
| CloudFront distribution | `fantasy-league-<env>-cdn` (via `comment`/tag) |
| CloudFront Function | `fantasy-league-<env>-url-rewrite` |
| IAM roles | `fantasy-league-<env>-<lambda>-role` |
| GitHub OIDC deploy role | `fantasy-league-<env>-deploy-role` |

- **SSM parameter paths:** `/fantasy-league/<env>/<key>` — e.g.
  `/fantasy-league/prod/database-url`, `/fantasy-league/prod/auth-token-secret`,
  `/fantasy-league/prod/football-data-api-key`, `/fantasy-league/prod/cognito-user-pool-id`.
- **Tags on every resource** (applied stack-wide via `Tags.of(app)`):
  `Project=fantasy-league`, `Environment=<env>`, `ManagedBy=cdk`,
  `Component=<network|data|api|worker|web>`. These drive cost-allocation reporting.

## Security & best-practice checklist (must be satisfied + documented)

Following these is a requirement, not a nice-to-have. Each is enforced in the CDK code
and checked at review.

**Identity & access**
- [ ] **Least-privilege IAM per Lambda** — each function gets its own role with only
      the SSM params / RDS-connect / logs it needs. No shared "god" role.
- [ ] **No long-lived AWS keys in CI** — GitHub Actions authenticates via **OIDC** to
      `fantasy-league-<env>-deploy-role`.
- [ ] **No ClickOps** — all infra is defined in CDK. Manual console changes are
      forbidden; they cause drift and break reproducibility. The Cognito pool is the
      one imported existing resource, documented as such.

**Data protection**
- [ ] **Encryption at rest** — RDS `storageEncrypted: true`, S3 SSE, SSM SecureString
      (KMS). **In transit** — RDS forces TLS; CloudFront is HTTPS-only (TLS 1.2+).
- [ ] **Secrets only in SSM SecureString** — never in the repo, env files, or the CDK
      template as plaintext. `.env` stays gitignored (already is).
- [ ] **Database is private** — `publiclyAccessible: false`, SG ingress 5432 from the
      Lambda SG only, no route from the internet.
- [ ] **Prod RDS deletion protection on** + final snapshot on delete.

**Network**
- [ ] **S3 bucket:** Block Public Access on; served only via CloudFront **OAC**.
- [ ] **Security groups least-privilege:** NAT SG allows egress to internet + ingress
      from private subnets only; Lambda SG egress to DB + internet (via NAT); DB SG
      ingress from Lambda SG only.

**Operations**
- [ ] **Structured logging to CloudWatch** from every Lambda; log group retention set
      (e.g. 30 days) so logs don't accrue cost forever.
- [ ] **Reserved concurrency** on Lambdas that hit RDS, to cap DB connections.
- [ ] **Pinned dependencies** (`package-lock.json` committed; `npm ci` in CI).
- [ ] **Environment parity** — dev/staging/prod are the same CDK app with different
      `<env>` context, not divergent hand-built stacks.
- [ ] **Cost guardrail** — an AWS Budgets alarm on the `Project=fantasy-league` tag.

## CDK stack — resources to define (`infra/`)

One stack, roughly:

1. **Networking:** `Vpc` (2 AZs, public+private), `cdk-fck-nat` NAT provider.
2. **Database:** `DatabaseInstance` — Postgres, `t4g.micro`, private subnets,
   `publiclyAccessible: false`, `storageEncrypted: true`, 20 GB gp3, single-AZ,
   auto-generated master credentials stored in SSM (or Secrets Manager if preferred
   for rotation — but default to the SSM param the app reads). DB SG: ingress 5432
   from the Lambda SG only.
3. **Secrets (SSM SecureString params):** `AUTH_TOKEN_SECRET`,
   `FOOTBALL_DATA_API_KEY`, `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, and the
   composed `DATABASE_URL`. Grant read to the Lambda roles.
4. **API Lambda:** `NodejsFunction` (ARM64), entry `src/api/lambdaHandler.ts`, in VPC
   + Lambda SG, env from SSM. Fronted by an **HTTP API** with a `/{proxy+}`
   catch-all → this Lambda.
5. **Worker Lambdas:** two `NodejsFunction`s (`src/workers/handler.ts`,
   `src/workers/monthlyPriceUpdateHandler.ts`), in VPC, with **EventBridge Schedule
   rules** (match poll `rate(1 minute)`–`rate(5 minutes)`; price update
   `cron(...monthly...)`). Reasonable `timeout` (e.g. worker 60–120 s) + small
   reserved concurrency.
6. **Migration Lambda:** `NodejsFunction`, entry `src/db/migrateLambda.ts` (new,
   below), in VPC. Not scheduled — invoked by CI after deploy.
7. **Frontend:** private `Bucket` + `Distribution` with S3 origin (OAC), a
   `Function` for the extensionless rewrite, and a second behavior `/api/*` → the
   HTTP API origin (so no CORS). `BucketDeployment` can upload `./out`, or CI syncs
   it (preferred — see CI).

## Application code changes (small, additive)

1. **`src/api/lambdaHandler.ts` (new)** — an `APIGatewayProxyHandler` that reuses the
   existing route-matching from `src/api/routes.ts`. Extract the shared dispatch
   currently inlined in `src/api/localServer.ts` (`matchRoute` + invoke + response)
   into a shared function both call. No changes to individual handlers.
2. **`src/db/client.ts`** — add `ssl: { ca: <RDS CA bundle>, rejectUnauthorized: true }`
   (bundle the `rds-combined-ca-bundle`/global CA) and a small `max` (1–2) on the
   `Pool` for Lambda. Keep local dev working (skip `ssl` when `DATABASE_URL` is
   local/`sslmode=disable`).
3. **`src/db/migrateLambda.ts` (new)** — a handler that runs Drizzle's migrator
   (`migrate(db, { migrationsFolder: "src/db/migrations" })`) and returns a summary.
   Bundle the `migrations/` SQL as Lambda assets. This replaces "run `db:migrate`
   from CI" — **CI can't reach the now-private RDS directly.**

## Secrets & config

- **Backend secrets** live only in SSM SecureString; Lambdas read them (via NAT) or
  receive them as deploy-time-injected env vars. Never in the repo or the CDK template
  as plaintext.
- **Cognito already live:** import pool `us-east-1_DBETCnAJP` + no-secret SRP client
  `8rv8u5ctrdranj2ev6d0en122` into the stack (or reference by id). Set
  `AUTH_PROVIDER=cognito` in the deployed API Lambda env.
- **Frontend build-time env** (`NEXT_PUBLIC_COGNITO_*`, API base = same-origin `/api`)
  injected during `next build` in CI.
- Delete the unused pool `us-east-2_MF6XS4BiK` once cutover is confirmed.

## CI/CD — GitHub Actions

Two workflows (or one gated pipeline):

1. **CI (on PR + push):** `npm ci` → `npm run typecheck` → `npx vitest run`. Blocks merge.
2. **Deploy (on push to `main`, manual approval):**
   a. `npm ci`
   b. `cdk deploy` (infra + Lambdas)
   c. **Invoke the migration Lambda** (`aws lambda invoke`) → fail the deploy on
      non-zero migration result
   d. `next build` (with `NEXT_PUBLIC_*` env) → `aws s3 sync ./out s3://<bucket> --delete`
   e. CloudFront invalidation (`/*`)
   Use GitHub OIDC → a deploy IAM role (no long-lived AWS keys).

## Deployment sequence (first cutover)

1. Bootstrap CDK (`cdk bootstrap`) in the target account/region (`us-east-1`).
2. Put real secret values into SSM SecureString params.
3. `cdk deploy` — creates VPC, NAT instance, RDS, Lambdas, HTTP API, CloudFront.
4. Invoke the migration Lambda → schema created on RDS.
5. Run the roster hydration path as needed (`hydrate:roster`) — or the existing seed —
   to populate players (subject to the free/paid API-Football plan, tracked separately).
6. Build + sync the frontend to S3, invalidate CloudFront.
7. Smoke test (below). Then run the one-time **Strategy 3** live API-Football check.

## Verification

- `cdk synth` clean; deploy to a throwaway/staging stack first.
- `curl https://<dist>.cloudfront.net/api/gameweeks/current` → 200 through CloudFront,
  **no CORS error** (same-origin).
- Hard-refresh `https://<dist>.cloudfront.net/login` → served (confirms CloudFront
  Function rewrite; no 404).
- Full click-through against the deployed API: Cognito sign-up/confirm → login →
  create league → squad builder → transfers deep link.
- Confirm **RDS has no public endpoint** and is unreachable except from the Lambda SG.
- Manually invoke the worker Lambda once → confirm a poll cycle logs + writes to RDS.
- Kill the NAT instance → confirm ASG relaunches it and egress recovers (~2–4 min),
  and that a missed worker poll simply retries next cycle with no data loss.

## Cost summary (us-east-1)

| Item | Year 1 | After Year 1 |
|---|---|---|
| RDS `db.t4g.micro` + 20 GB | $0 (free tier) | ~$14/mo |
| fck-nat NAT instance (`t4g.nano`) | ~$0 (free-tier eligible) | ~$3/mo |
| Lambda + HTTP API | ~$0 (free tier) | ~$0–1/mo |
| CloudFront + S3 | ~$0–1/mo | ~$0–1/mo |
| Cognito / SSM | $0 | $0 |
| **Total** | **~$0–2/mo** | **~$17–18/mo** |

Ongoing ops: ~15 min/quarter for NAT instance patching (or automate via SSM Patch
Manager). Swapping fck-nat → managed NAT Gateway later is a one-line CDK change if
zero-maintenance HA is ever wanted (~+$30/mo).

## Out of scope for this task (tracked elsewhere)

- Full player roster hydration on a paid API-Football plan (`remaining-gaps-todo.md`
  item 6).
- Admin tools, monitoring/alerting, custom domain, beta testing (ROADMAP M3).
- Multi-AZ RDS / managed NAT Gateway HA — only if growth demands it.
