# Deployment Runbook — as actually run (first prod deploy, 2026-07-11)

Every command from the first production deployment, in order, with what it does and why.
Unlike `DEPLOYMENT_GUIDE.md` (the plain-language overview) this is the exact, replayable
record — treat it as the reference for redeploys, new environments, and rebuilds.

Deployment target: account `345482189946`, region **us-east-1** (locked in: the live
Cognito pool `us-east-1_DBETCnAJP` lives there). The AWS CLI's default region on this
machine is us-east-2, so **every command carries `--region us-east-1` explicitly** —
keep doing that.

The infrastructure definition is the CDK app in `infra/` (see
`DEPLOYMENT_PLAN.md` for the architecture). App-side deploy code:
`src/api/lambdaHandler.ts` (API entrypoint), `src/db/migrateLambda.ts` (schema
migration), `src/runtimeConfig/loadRuntimeConfigFromSsm.ts` (secret loading at Lambda
cold start), `src/db/client.ts` (RDS TLS via the committed
`src/db/rds-us-east-1-ca-bundle.pem`).

---

## Scripted deployment (preferred since 2026-07-12)

Every step below is now automated in `scripts/` with the first deploy's lessons baked
in as guardrails (account check, region pinning, quota detection, idempotent secrets,
`?sslmode=require`, plugin self-install — see **Troubleshooting** for each story).
The manual sections that follow remain the *explanation* of what the scripts do.

| Command | What it does |
|---|---|
| `npm run deploy:preflight` | Read-only checks: account, region, bootstrap, all 6 secrets, Lambda quota, tunnel plugin. |
| `npm run deploy:secrets` | Creates any missing SSM parameters. **Never overwrites** existing ones. |
| `npm run deploy:infra` | `cdk diff` → confirm → `cdk deploy` (context flags auto-derived). |
| `npm run deploy:infra:cli` | Same stack via plain AWS CLI: `cdk synth` → `cdk-assets publish` → `aws cloudformation deploy`. |
| `npm run deploy:migrate` | Invokes the migration Lambda; fails loudly on a bad result. |
| `npm run deploy:frontend` | `next build` (env from SSM + stack outputs) → S3 sync → CloudFront invalidation. |
| `npm run deploy:smoke` | The verification checks (API via CF, URL rewrite, private RDS, rule state). |
| `npm run deploy:all` / `deploy:all:cli` | The whole sequence in order, either infra path. |
| `npm run db:tunnel` | SSM port-forward to RDS via the NAT instance; prints the `?sslmode=require` connection recipe; installs the plugin on first use. |
| `npm run destroy` | Prints the full ordered teardown plan (read-only). `-- --execute` performs it: stack + retained bucket/DB + SSM params, with final snapshot. Prod needs `ALLOW_PROD_DESTROY=yes`. See **Teardown**. |

**The two infra paths are the same deployment.** CDK is a template compiler: `synth`
emits `infra/cdk.out/FantasyLeague-Prod.template.json` plus an asset manifest;
`cdk-assets publish` uploads the Lambda bundles to the bootstrap bucket; and from
there plain `aws cloudformation deploy` is fully equivalent to `cdk deploy`
(`--s3-bucket` is required — the template is ~65 KB, past CloudFormation's 51,200-byte
direct-body limit). Expect the *first* switch between paths to show a one-time
update of the Lambdas/rules (asset + metadata reconciliation); after that `cdk diff`
is clean and both paths no-op on an unchanged stack — verified 2026-07-12.
Enable the match-poll schedule with `--enable-match-poll` (see deviation 7);
reserved concurrency turns itself on automatically once the quota increase lands.

---

## 0 — Prerequisites (verify before anything)

```bash
aws sts get-caller-identity          # must print account 345482189946
node --version                       # v24.x
cd infra && npm install              # installs aws-cdk CLI + aws-cdk-lib + cdk-fck-nat
```

Also check the Lambda concurrency limit (read-only):

```bash
aws lambda get-account-settings --region us-east-1
```

**Finding on first run:** this account has the new-account limit of **10 concurrent
executions**. Reserved concurrency needs limit − reservations ≥ 100, so the stack's
reserved-concurrency settings are behind a context flag and were deployed OFF.
Follow-up: request an increase to 1,000 in Service Quotas (quota `L-B99A9384`,
free, usually auto-approved), then redeploy with `-c reservedConcurrency=true`.
Until then the match-poll worker's overlap safety comes from the DB-persisted
`nextLivePollDueAt` gate in `src/workers/liveMatchPolling.ts` (which is also the
primary mechanism — reserved concurrency is belt-and-braces).

## 1 — CDK bootstrap (one-time per account+region)

```bash
cd infra
npx cdk bootstrap aws://345482189946/us-east-1
```

Creates the `CDKToolkit` CloudFormation stack (12 resources): an S3 bucket for
deployment assets (bundled Lambda zips), an ECR repo, and IAM roles CloudFormation
assumes during deploys. Never needs re-running unless AWS announces a new bootstrap
version. **Ran 2026-07-11: ✅ 12/12 resources created.**

## 2 — Secrets → SSM Parameter Store (one-time per environment)

Six SecureString parameters under `/fantasy-league/prod/`. Values are piped in from
`openssl rand` (fresh secrets) or `.env` (existing ids) so they never land on screen
or in shell history. **No `--overwrite`** — an existing parameter makes the command
fail instead of silently replacing it (deliberate idempotency guard). Rotating a
secret later is an explicit `aws ssm put-parameter --overwrite`.

```bash
# fresh, hex/base64 so they're URL- and RDS-password-safe
aws ssm put-parameter --region us-east-1 --name /fantasy-league/prod/auth-token-secret \
    --type SecureString --value "$(openssl rand -base64 48)"
aws ssm put-parameter --region us-east-1 --name /fantasy-league/prod/db-password \
    --type SecureString --value "$(openssl rand -hex 24)"
aws ssm put-parameter --region us-east-1 --name /fantasy-league/prod/db-app-password \
    --type SecureString --value "$(openssl rand -hex 24)"

# copied from local .env
aws ssm put-parameter --region us-east-1 --name /fantasy-league/prod/football-data-api-key \
    --type SecureString --value "$(grep '^FOOTBALL_DATA_API_KEY=' .env | cut -d= -f2-)"
aws ssm put-parameter --region us-east-1 --name /fantasy-league/prod/cognito-user-pool-id \
    --type SecureString --value "$(grep '^COGNITO_USER_POOL_ID=' .env | cut -d= -f2-)"
aws ssm put-parameter --region us-east-1 --name /fantasy-league/prod/cognito-app-client-id \
    --type SecureString --value "$(grep '^COGNITO_APP_CLIENT_ID=' .env | cut -d= -f2-)"
```

What each is for:

| Parameter | Consumer | Purpose |
|---|---|---|
| `auth-token-secret` | API Lambda | HMAC secret for the signed-token auth fallback. **Fresh for prod** — dev's secret can't mint prod sessions. |
| `db-password` | RDS (via CloudFormation dynamic reference) + migration Lambda | Master password for `fantasy_admin`. Never used by the app at runtime. |
| `db-app-password` | API/worker Lambdas + migration Lambda | Password for `fantasy_app`, the least-privilege DML-only role the app connects as. The migration Lambda creates/updates this role. |
| `football-data-api-key` | worker Lambdas | API-Football key. |
| `cognito-user-pool-id` / `cognito-app-client-id` | API Lambda | The live, imported Cognito pool (`us-east-1_DBETCnAJP` / `8rv8u5ctrdranj2ev6d0en122`). |

Verify (names only; values stay encrypted):

```bash
aws ssm get-parameters-by-path --region us-east-1 --path /fantasy-league/prod \
    --query "Parameters[].Name"
```

**Ran 2026-07-11: ✅ all six at Version 1.**

How Lambdas consume these: CloudFormation cannot put SecureString values into Lambda
env vars, so each Lambda's entrypoint calls `loadRuntimeConfigFromSsm()` once per cold
start — `GetParametersByPath` (decrypted) → `process.env`, composing `DATABASE_URL`
from the password parameter + the plain `DB_HOST/PORT/NAME/USER` env the stack injects.
The one exception is the RDS master password, which CloudFormation reads directly via a
`{{resolve:ssm-secure:...}}` dynamic reference at deploy time.

## 3 — Synth, diff, deploy

```bash
cd infra
npx cdk synth --quiet     # compile TS → CloudFormation; bundles Lambdas; creates nothing
npx cdk diff              # review gate: exactly what will be added/changed/REPLACED
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

- `synth` makes one read-only AWS call (EC2 DescribeImages, fck-nat AMI lookup) and
  caches it in `infra/cdk.context.json` — commit that file.
- **Always read the diff.** On this first run everything was `[+] add` (64 resources).
  On future runs, watch for *replacement* markers on stateful resources (RDS!).
- `--require-approval never` only suppresses the interactive IAM-changes prompt; the
  diff review above is the real gate. `--outputs-file` saves the stack outputs
  (CloudFront URL, bucket name, Lambda names…) to `infra/cdk-outputs.json`.
- First deploy takes ~15–20 min (RDS and CloudFront are the slow ones).

**Ran 2026-07-11: ✅ 64 resources created in ~13 min; a second deploy the same evening
(schedule fixes, see Known deviations) updated 6 resources in 82 s.**

## 4 — Create the database schema (after every deploy that adds migrations)

```bash
aws lambda invoke --region us-east-1 --function-name fantasy-league-prod-migrate \
    --cli-binary-format raw-in-base64-out /dev/stdout
```

Runs Drizzle's migrator inside the VPC (a laptop can't reach the private RDS), then
ensures the `fantasy_app` role exists with DML-only grants (using `db-app-password`).
Expect `{"status":"migrations-applied","appliedMigrationCount":8,...}`.

**Ran 2026-07-11: ✅**
`{"status":"migrations-applied","appliedMigrationCount":8,"publicTableCount":14,"appRoleEnsured":true}`

## 5 — Seed data (first deploy only)

The RDS instance is private; the sanctioned admin path is SSM Session Manager
port-forwarding through the NAT instance (no bastion, no public DB).

One-time local prerequisite — the Session Manager plugin for the AWS CLI:
`brew install --cask session-manager-plugin` (needs sudo). The first deploy installed
it without sudo instead: download AWS's `sessionmanager-bundle.zip` (mac), copy
`bin/session-manager-plugin` to `~/.local/bin`, and have `PATH` include that dir.

```bash
# find the NAT instance id
aws ec2 describe-instances --region us-east-1 \
    --filters "Name=tag:aws:autoscaling:groupName,Values=<NatAutoScalingGroupName output>" \
              "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].InstanceId" --output text

# tunnel localhost:15432 → RDS 5432 via the NAT instance
aws ssm start-session --region us-east-1 --target <instance-id> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters host="<DatabaseEndpoint output>",portNumber="5432",localPortNumber="15432"

# in another terminal, with the master password from SSM — note ?sslmode=require
DATABASE_URL="postgres://fantasy_admin:$(aws ssm get-parameter --region us-east-1 \
    --name /fantasy-league/prod/db-password --with-decryption \
    --query Parameter.Value --output text)@localhost:15432/fantasy_league?sslmode=require" \
    npm run seed:mock
```

**`?sslmode=require` is mandatory** — learned the hard way on the first run. RDS
enforces TLS (`rds.force_ssl=1`), but through the tunnel the client sees hostname
`localhost` (which normally means "local docker, no TLS"), and full certificate
verification can't work anyway because the server cert names the RDS host, not
localhost. `sslmode=require` in our db client means: encrypt, skip verification —
safe here because the SSM tunnel already authenticates both endpoints. The DB
security group allows 5432 from the NAT instance's SG for exactly this path — a
deliberate, documented exception to "Lambda SG only".

**Ran 2026-07-11: ✅** 20 mock players + 1 gameweek + 2 completed matches seeded,
scoring pipeline executed.

## 6 — Build + publish the frontend (every frontend change)

```bash
# from the repo root — NEXT_PUBLIC_* is baked in at build time
NEXT_PUBLIC_API_BASE_URL="/api" \
NEXT_PUBLIC_COGNITO_USER_POOL_ID="us-east-1_DBETCnAJP" \
NEXT_PUBLIC_COGNITO_APP_CLIENT_ID="8rv8u5ctrdranj2ev6d0en122" \
npm run build

aws s3 sync ./out "s3://fantasy-league-prod-web-345482189946" --delete --region us-east-1
aws cloudfront create-invalidation --distribution-id <CloudFrontDistributionId output> --paths "/*"
```

`NEXT_PUBLIC_API_BASE_URL="/api"` makes the browser call the site's own origin (the
CloudFront `/api/*` behavior) — same-origin, so no CORS. `--delete` removes stale
files; the invalidation makes CloudFront re-fetch from S3 (first 1,000 paths/month
free).

## 7 — Smoke tests

```bash
curl -i https://<dist>.cloudfront.net/api/gameweeks/current   # 401 (auth required) or 200 — NOT 404/CORS
curl -i https://<id>.execute-api.us-east-1.amazonaws.com/gameweeks/current  # 403 — origin lock closed
curl -i https://<dist>.cloudfront.net/login                    # 200 — proves the URL-rewrite Function
aws rds describe-db-instances --region us-east-1 \
    --db-instance-identifier fantasy-league-prod-db \
    --query "DBInstances[0].PubliclyAccessible"                # false
aws lambda invoke --region us-east-1 --function-name fantasy-league-prod-worker \
    --cli-binary-format raw-in-base64-out /dev/stdout          # one manual poll cycle; then check logs
aws logs tail /aws/lambda/fantasy-league-prod-worker --region us-east-1 --since 10m
```

Then the human click-through: Cognito login → create league → squad builder →
transfers deep link.

---

## Stack outputs (first deploy, 2026-07-11)

| Output | Value |
|---|---|
| CloudFrontUrl (**the live site**) | `https://d2dhnsmye25s6d.cloudfront.net` |
| CloudFrontDistributionId | `E3ELMZYGU56ZXK` |
| WebBucketName | `fantasy-league-prod-web-345482189946` |
| HttpApiEndpoint | `https://uu73i5l9d5.execute-api.us-east-1.amazonaws.com` |
| DatabaseEndpoint | `fantasy-league-prod-db.cozy0yaicn83.us-east-1.rds.amazonaws.com` |
| Lambdas | `fantasy-league-prod-api` / `-worker` / `-price-update` / `-migrate` |
| NAT instance (at deploy time) | `i-053c1fc3f3ecc8ce5` (ASG-managed — re-discover by ASG tag, step 5) |

Machine-readable copy: `infra/cdk-outputs.json` (or
`aws cloudformation describe-stacks --stack-name fantasy-league-prod --region us-east-1`).

Smoke tests ran 2026-07-11: **✅ all four** — API 401-with-JSON through CloudFront
(full edge→APIGW→Lambda→SSM→Cognito→RDS path), `/login` rewrite 200, RDS
`PubliclyAccessible: false`, worker cycle logged to CloudWatch (see deviation 7).

## Everyday operations

- **Ship a backend/infra change:** `npm run deploy:infra` (shows the diff, asks, deploys)
  — or `npm run deploy:infra:cli` for the CloudFormation-CLI path.
- **Ship a frontend change:** `npm run deploy:frontend`.
- **New migration:** `npm run db:generate` locally → `npm run deploy:infra` (bundles the
  SQL) → `npm run deploy:migrate`.
- **Everything at once:** `npm run deploy:all` (preflight → secrets → infra → migrate →
  frontend → smoke).
- **Read logs:** `aws logs tail /aws/lambda/fantasy-league-prod-api --region us-east-1 --follow`
  (same for `-worker`, `-price-update`, `-migrate`).
- **Rotate a secret:** `aws ssm put-parameter --overwrite ...` then redeploy (or wait for
  Lambda cold starts to pick it up; the DB master password additionally needs a stack update).
- **DB admin access:** `npm run db:tunnel` (SSM port-forward; prints the connection
  recipe). There is intentionally no bastion.
- **Find everything in the console:** Resource Groups → **`fantasy-league-prod-resources`**
  (tag query on `Project=fantasy-league` + `Environment=prod`; 35+ resources including
  the CloudFront distribution, NAT instance/volume, and RDS snapshot).
- **Second environment:** `ENVIRONMENT_NAME=staging npm run deploy:all` after putting
  staging secrets under `/fantasy-league/staging/` (scripts read `ENVIRONMENT_NAME`,
  default `prod`).
- **Teardown:** `npm run destroy` (plan-only by default) — see the **Teardown** section;
  a bare `cdk destroy` is deliberately NOT complete (retained bucket/DB, SSM params).
  Prod is guarded by termination protection, RDS deletion protection, a typed
  confirmation, AND `ALLOW_PROD_DESTROY=yes` — all on purpose.

## SES for Cognito email (manual, one-time per environment — recommended before real signups)

Cognito's default email sender (`EmailSendingAccount=COGNITO_DEFAULT`, the implicit
setting today) is capped low enough that a real signup wave will silently stop
delivering confirmation codes. Switching to SES removes the cap — but SES starts in
**sandbox mode**, which only sends to addresses/domains you've explicitly verified.
Sandbox mode alone does **not** solve "real users signing up with arbitrary email
addresses" — production access must be requested separately (below).

No custom domain exists yet, so the simplest sender identity for now is
`andy.illegalized@gmail.com` — the same address as `BUDGET_ALERT_EMAIL` in the CDK
stack. Cognito isn't CDK-managed (the pool is imported by ID only, via SSM params —
there's no `cognito.UserPool` construct to change), so all of this is out-of-band CLI
work, same as how the pool itself was originally set up.

### 1 — Verify a sender identity in SES

```bash
aws sesv2 create-email-identity --region us-east-1 \
    --email-identity andy.illegalized@gmail.com
```

This sends a verification email to that address — click the link in it. Confirm:

```bash
aws sesv2 get-email-identity --region us-east-1 \
    --email-identity andy.illegalized@gmail.com \
    --query "VerifiedForSendingStatus"        # must be true before continuing
```

### 2 — Point Cognito at the verified identity

```bash
aws cognito-idp update-user-pool --region us-east-1 \
    --user-pool-id us-east-1_DBETCnAJP \
    --email-configuration SourceArn=arn:aws:ses:us-east-1:345482189946:identity/andy.illegalized@gmail.com,EmailSendingAccount=DEVELOPER
```

**⚠ Before running this**: `update-user-pool` does not merge — some sub-blocks of the
user pool config can be reset to defaults if you don't re-specify them alongside
`--email-configuration`. Always run `aws cognito-idp describe-user-pool --user-pool-id
us-east-1_DBETCnAJP` first, diff the output against what you're about to set, and
re-pass any unrelated settings (password policy, MFA config, etc.) explicitly in the
same call if there's any doubt. Verify immediately after with another
`describe-user-pool` that nothing unrelated changed.

No separate IAM permission is expected on Cognito's side: `EmailSendingAccount=DEVELOPER`
with a verified identity in the *same account and region* is documented as using
Cognito's own service-linked access to call SES — this is a same-account,
same-region setup (SES identity and Cognito pool both in `345482189946`/`us-east-1`),
so no cross-account SES identity resource policy should be needed. If confirmation
emails silently fail to send after this change, check SES sending statistics /
CloudTrail for an AccessDenied from `cognito-idp.amazonaws.com` first — that would mean
this assumption was wrong for this account and an explicit SES identity policy is
needed after all.

### 3 — Request SES production access (removes the sandbox restriction)

Sandbox mode caps you to verified recipients only — this step is what actually lets
real users' inboxes receive confirmation codes.

```bash
aws sesv2 put-account-details --region us-east-1 \
    --mail-type TRANSACTIONAL \
    --website-url https://<cloudfront-url-or-future-custom-domain> \
    --use-case-description "Transactional account-confirmation and password-reset emails for a small fantasy football league app (Cognito-driven signup flow), low volume." \
    --production-access-enabled
```

**⚠ Verify before using verbatim**: run `aws sesv2 put-account-details help` and
cross-check the parameter names against the installed CLI version first — a
rejected/malformed request here just means falling back to the SES console "Request
production access" form, which needs the same information either way. Production
access requests are reviewed by AWS (usually within 24h) — not instant.

## Release process — `main` → `release` → deploy

Two branches, two gates:

- **`main`** — where PRs land. Gated by `.github/workflows/ci.yml`'s fast `test` /
  `infra-synth` jobs (typecheck + vitest, `cdk synth`) on every PR, plus a slower
  `integration-smoke` job (the existing `npm run smoke:recorded` Playwright suite
  against a real Postgres service container) that runs once a PR has merged to `main`.
- **`release`** — what actually deploys. Promote by opening a PR from `main` into
  `release` once `main`'s latest commit shows a green `integration-smoke` check;
  merging it triggers `.github/workflows/deploy.yml`, which itself waits on the
  `production` GitHub Environment's manual-approval gate before touching AWS.

**One-time manual repo setup** (none of this can be declared from a workflow file):
1. Create the `release` branch: `git branch release main && git push -u origin release`.
2. Repo Settings → Branches → add a protection rule on `release` requiring the
   `integration-smoke` status check to pass before merging. (GitHub associates check
   runs with the commit SHA, not the branch it ran on, so the check that ran on `main`
   shows up automatically on the `main`→`release` PR for that same commit — no extra
   workflow plumbing needed, just this rule.)
3. Repo Settings → Environments → create `production`, turn on **Required reviewers**.
   This is the second, independent approval gate `deploy.yml`'s `environment:
   production` line references — the reference alone does nothing without this rule.
4. `cd infra && npx cdk deploy FantasyLeagueGitHubDeploy` once, to create the GitHub
   OIDC provider + `fantasy-league-prod-deploy-role` that `deploy.yml` assumes. This
   stack is separate from the per-environment app stack and isn't part of
   `deploy-everything.sh` — see `infra/lib/githubDeployStack.ts`'s doc comment for why.

## Teardown — destroying an environment completely

**Scripted (preferred):** `npm run destroy` prints the full ordered plan (read-only);
`npm run destroy -- --execute` performs it after a typed confirmation. Prod requires
`ALLOW_PROD_DESTROY=yes` on top. `--via cli` swaps `cdk destroy` for plain
`aws cloudformation delete-stack`; `--no-final-snapshot` skips the RDS snapshot.

**Why a bare `cdk destroy` is NOT a complete teardown.** Some resources are retained
by design, and some were never stack-owned — each would silently keep billing or
linger forever:

| Leftover after `cdk destroy` | Why | Cost if forgotten |
|---|---|---|
| Web S3 bucket (all envs) | `RemovalPolicy.RETAIN` | storage + request pennies, forever |
| RDS instance (**prod only**) | `RETAIN` + deletion protection | **~$14/mo — the big one** |
| The 6 SSM parameters | created out-of-band; stack only reads them | free, but confusing drift |
| RDS final snapshot | taken *on purpose* during teardown | ~$0.095/GB-mo until deleted |
| CDKToolkit bootstrap stack | shared account infra, not ours to auto-delete | pennies (asset storage) |
| Cognito user pool | imported + live — teardown must never touch it | free tier |

**The proper order** (what the script automates — the numbered plan it prints matches
this exactly). The database is deleted **before** the stack, not after — see the
2026-07-13 incident below for why:

1. **Empty the web bucket** — a retained bucket keeps billing; a non-empty bucket can't
   be deleted later anyway. `aws s3 rm s3://fantasy-league-<env>-web-<account> --recursive`
2. **Prod only: drop the two guards** — stack termination protection
   (`aws cloudformation update-termination-protection --no-enable-termination-protection`)
   and RDS deletion protection (`aws rds modify-db-instance --no-deletion-protection
   --apply-immediately`). Both exist precisely to make step 5 fail when unintended.
3. **Prod only: delete the retained database with a final snapshot** —
   `aws rds delete-db-instance --db-instance-identifier fantasy-league-<env>-db
   --final-db-snapshot-identifier fantasy-league-<env>-final-<date>`, then wait
   (`aws rds wait db-instance-deleted`). Non-prod skips this — its removal policy is
   DESTROY, so the stack delete in step 5 removes it directly. **Must happen before the
   stack delete**: while the instance is alive, its ENI keeps the DB security group,
   parameter group, and one VPC subnet in use, and CloudFormation can't delete any of
   those until it's gone.
4. *(implicit)* CloudFormation handles internal ordering — CloudFront disable+delete is
   the slow part (10–20 min); the NAT ASG terminates its instance, which frees the
   static ENI for deletion; the root EBS volume dies with the instance.
5. **Delete the stack**, either way:
   - CDK: `cd infra && npx cdk destroy FantasyLeague-<Env> -c env=<env> --force`
   - CLI: `aws cloudformation delete-stack --stack-name fantasy-league-<env>` then
     `aws cloudformation wait stack-delete-complete --stack-name fantasy-league-<env>`
6. **Delete the orphaned DB subnet group** (prod) — it inherits the same
   `RemovalPolicy.RETAIN` as the database instance, so it's always `DELETE_SKIPPED` by
   step 5 regardless of ordering: `aws rds delete-db-subnet-group --db-subnet-group-name
   <captured from the stack before deletion — no deterministic name, unlike the DB
   instance>`. Free to leave, but clutters the account forever if skipped.
7. **Delete the now-empty retained bucket**: `aws s3 rb s3://fantasy-league-<env>-web-<account>`
8. **Delete the six SSM parameters**: `aws ssm delete-parameters --names
   /fantasy-league/<env>/{auth-token-secret,db-password,db-app-password,football-data-api-key,cognito-user-pool-id,cognito-app-client-id}`
9. **Verify nothing is left**: explicitly confirm the VPC (physical ID captured from the
   stack before deletion) no longer exists via `aws ec2 describe-vpcs`, then sweep the
   tagging API (the Resource Group itself died with the stack): `aws
   resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=fantasy-league
   Key=Environment,Values=<env>` — expect only the final snapshot (and a few minutes of
   tag-index lag for CloudFront).

**Later, when certain:** delete the final snapshot
(`aws rds delete-db-snapshot --db-snapshot-identifier fantasy-league-<env>-final-<date>`).

**As-run: first prod teardown (2026-07-13).** The script at the time deleted the
database *after* the stack (old step 4 then 5). The live instance's ENI was still
attached to `DatabaseSecurityGroup`, `DatabaseParameterGroup`, and one private subnet,
so `cdk destroy` deleted everything else first and then failed on those three —
`DELETE_FAILED`, stack stuck, RDS instance left running with deletion protection
already off. Recovery: manually ran `aws rds delete-db-instance` (with final snapshot)
on the stuck instance, waited for it to finish, then re-ran `cdk destroy` — it
succeeded cleanly on retry since nothing was still using the blocked resources.
Verification afterward also turned up an orphaned `AWS::RDS::DBSubnetGroup` (retained,
cascaded from the DB instance's removal policy, `DELETE_SKIPPED` by the stack, not
previously accounted for in this runbook or the script) — deleted manually. Fixed in
`scripts/destroy-environment.sh`: the DB delete now runs before the stack delete
(so this can't recur), a step deletes the orphaned subnet group unconditionally, and
verification explicitly asserts the VPC is gone rather than only sweeping tags. Prod
was fully torn down (stack, VPC, database, snapshot, bucket, SSM params) as of
2026-07-13 — see `docs/deployment/README.md` for current status before redeploying.

**Appendix — abandoning CDK in this account entirely** (only if nothing else will ever
use CDK here): empty the versioned bootstrap bucket *including all object versions*
(`cdk-hnb659fds-assets-345482189946-us-east-1` — versioned buckets need a
delete-object-versions sweep, not just `s3 rm`), then delete the `CDKToolkit` stack
and its ECR repo. Skip this if you might redeploy — re-bootstrapping is the one
command, but the asset re-uploads are avoidable churn.

**Rebuilding after a teardown** is just the deploy flow again: `npm run deploy:all`,
then restore data from the final snapshot (`aws rds restore-db-instance-from-db-snapshot`,
see `RELIABILITY_PLAN.md`) or re-seed via `npm run db:tunnel` + `npm run seed:mock`.

## Troubleshooting — every problem that surfaced, and where its fix now lives

| # | Symptom | Root cause | Fix | Now automated in |
|---|---|---|---|---|
| 1 | Deploy would fail on `ReservedConcurrentExecutions` | New AWS accounts get a Lambda concurrency limit of 10; reservations require limit − reserved ≥ 100 | Reservations behind the `reservedConcurrency` context flag; request quota `L-B99A9384` → 1000 in Service Quotas | `deploy-infrastructure.sh` auto-detects the quota and sets the flag; preflight reports it |
| 2 | Seed via tunnel: `no pg_hba.conf entry ... no encryption` | RDS forces TLS (`rds.force_ssl=1`) but the db client treats `localhost` (the tunnel) as a no-TLS local database | Append **`?sslmode=require`** — the client encrypts but skips cert verification (the cert names the RDS host, never localhost; the SSM tunnel authenticates endpoints) | `src/db/client.ts` handles the marker; `open-database-tunnel.sh` prints the exact recipe |
| 3 | Then: `self-signed certificate in certificate chain` | `pg` parses `sslmode=require` from the URL itself and its interpretation overrides the explicit `ssl` config | The client strips the marker from the string before `pg` sees it | `src/db/client.ts` |
| 4 | Worker ERROR-logging 3× per minute, burning API quota | Free API-Football plan can't serve the current season, `lastRosterImportRanAt` only stamps on success, and async Lambda retries ×3 | `retryAttempts: 0` on both EventBridge targets; match-poll rule ships DISABLED behind `matchPollEnabled` | `deploy-infrastructure.sh --enable-match-poll` when the paid plan lands |
| 5 | `brew install --cask session-manager-plugin` fails in scripts | The cask runs a `.pkg` installer that needs interactive sudo | No-sudo install: AWS's `sessionmanager-bundle.zip` → binary into `~/.local/bin` | `open-database-tunnel.sh` self-installs on first run; `deployment-env.sh` adds the PATH entry |
| 6 | Commands silently hit the wrong region | This machine's AWS CLI default region is `us-east-2`; the stack is locked to `us-east-1` (Cognito) | Region pinned once, inherited everywhere | `deployment-env.sh` exports `AWS_DEFAULT_REGION`; preflight warns about hand-typed commands |
| 7 | Resource Group `CREATE_FAILED: description ... must satisfy [\sa-zA-Z0-9_.-]*` | Resource Group descriptions forbid `/`, commas, etc. | Plain-words description | Comment in `infra/lib/fantasyLeagueStack.ts` |
| 8 | `aws cloudformation deploy` rejects the template | Template is ~65 KB; direct template bodies cap at 51,200 bytes | Route the template through S3 | `deploy-infrastructure.sh --via cli` passes `--s3-bucket` |
| 9 | CLI-path deploy fails with "No changes to deploy" | `aws cloudformation deploy` errors on an empty changeset by default | — | `--no-fail-on-empty-changeset` in `deploy-infrastructure.sh` |
| 10 | Risk: scripts run against the wrong AWS account | Multiple profiles/credentials on one machine | Hard account check before anything runs | `require_correct_aws_account` in `deployment-env.sh`, called by every script |
| 11 | **Every** API request returns 403 `"This API must be reached through the site, not directly"` | The origin lock's shared secret drifted between CloudFront and the API Lambda — usually a mid-rollout rotation (see follow-up 8), or the `cloudfront-origin-secret` SSM parameter was changed without a redeploy | Redeploy the stack so both sides re-read the parameter in one changeset, then wait for CloudFront to propagate (~5 min) | `deployment-preflight.sh` requires the parameter; `deployment-smoke-test.sh` asserts direct execute-api gives 403 while the CDN path gives 401 |
| 12 | Any stack update fails: `You can't remove or replace the web ACL for your distribution. Distributions with a pricing plan subscription must have a web ACL resource` | CloudFront's Free pricing plan auto-creates and attaches a WebACL when the distribution is first created. CDK never knew about it, so its template omitted `WebACLId` and CloudFormation tried to strip it | Read the live distribution's `WebACLId` and pass it back to CDK as `-c webAclArn=…`; the stack re-declares it via `existingWebAclArn`. Never hardcode — the ARN differs per environment, and is absent on a first deploy | `deploy-infrastructure.sh` discovers and passes it automatically on every deploy |
| 13 | Then: `Distributions with the Free pricing plan can't have the following features: Price class` | Same Free pricing plan pins every distribution to `PriceClass_All` and rejects the property outright. The stack had asked for `PRICE_CLASS_100` since day one and CloudFront silently ignored it — the live distribution was always `PriceClass_All` | Drop `priceClass` from the Distribution props. No behaviour change: it was never in effect | Removed, with the rationale inline in `infra/lib/fantasyLeagueStack.ts` |
| 14 | Teardown reports `ACTION REQUIRED`: `You can't delete this distribution while it's subscribed to a pricing plan` (HTTP 412), leaving the stack `DELETE_FAILED` | Same Free pricing plan. A subscribed distribution cannot be deleted, and **neither the CloudFront API nor the CLI exposes the subscription**, so nothing can check for it up front | Cancel the plan in the console (Distributions → the `-cdn` distribution → cancel pricing plan), then re-run `destroy-environment.sh --execute`. **Free plans cancel immediately**; paid plans only at the end of the billing cycle. The error text says "end of monthly billing cycle" regardless of tier — for a Free plan that is wrong, see [the docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) | `destroy-environment.sh` **defers rather than aborts**: it classifies this specific failure, finishes steps 6-9 (subnet group, bucket, SSM parameters, verification — the things that actually bill), and reports the one manual action once at the end, exiting non-zero so the run is never mistaken for complete. Every step is existence-guarded, so the re-run only finishes the stack delete |

## Known deviations / follow-ups

1. **Reserved concurrency off** (account limit 10) — request Service Quotas increase,
   then `npx cdk deploy -c reservedConcurrency=true`.
2. **API Lambda has no reserved concurrency** even at full quota — its DB pool is capped
   (`max: 2` per instance) and the account cap bounds total connections at MVP scale.
3. **Budget is account-wide**, not tag-scoped — tag-scoped budgets need cost-allocation
   tag activation (one-time, console) first.
4. **Mistyped page URLs return S3's plain 404 XML**, not a styled 404 page —
   distribution-wide custom error pages would also rewrite `/api/*` error bodies, which
   would break API clients. Revisit if it matters.
5. **CI/CD (GitHub Actions + OIDC) deferred** — see `DEPLOYMENT_PLAN.md` §CI/CD.
6. ~~Delete unused Cognito pool `us-east-2_MF6XS4BiK`~~ **Done 2026-07-12** — Drew deleted
   it ("User pool - oehbhj"); verified: us-east-2 has zero pools and the live pool
   `us-east-1_DBETCnAJP` ("User pool - nvl7mo") is intact with its users.
7. **Match-poll schedule is deployed DISABLED** (`-c matchPollEnabled=true` + deploy to
   turn on). Live verification showed every cycle failing at the first provider call:
   the free API-Football plan cannot serve current-season data (remaining-gaps item 6),
   and `lastRosterImportRanAt` is only stamped on success, so the import re-fails every
   minute, burning ~1 quota call/tick and blocking all later stages. Nothing is lost —
   the site reads precomputed DB data. Both EventBridge targets also now set
   `retryAttempts: 0`: for scheduled jobs the next tick is the retry; Lambda's default
   async double-retry only tripled the failing calls. Once a paid data plan lands:
   enable the flag, and the worker resumes with the polling-budget pacing.
8. **Rotating `cloudfront-origin-secret` briefly 403s live traffic** (added 2026-08-03).
   Rotation is `aws ssm put-parameter --overwrite --name /fantasy-league/<env>/cloudfront-origin-secret
   --type String --value "$(openssl rand -hex 32)"` followed by a stack deploy. One
   changeset updates both consumers, but a Lambda env var changes instantly while a
   CloudFront distribution takes ~5 minutes to propagate — so there is a window where the
   Lambda expects the new value and the CDN still sends the old one, and every request
   403s. **Rotate during low traffic.** Accepting two valid secrets for a rollout window
   would remove this; not worth the complexity at MVP scale.

   The parameter is deliberately a plain `String`, unlike every other parameter under
   `/fantasy-league/<env>/`: CloudFormation cannot resolve `{{resolve:ssm-secure}}` into a
   CloudFront origin custom header, and the value is readable via `aws cloudfront
   get-distribution-config` regardless of how it is stored. It proves a request came
   through the CDN; it guards no data on its own.
9. **The distribution is on CloudFront's Free pricing plan** (discovered 2026-08-03 — it was
   applied automatically at creation, not chosen). Three consequences the stack now works with
   rather than against, each of which blocked a deploy or a teardown until it was understood
   (troubleshooting rows 12-14): a WebACL is **mandatory** and CloudFront manages it,
   `PriceClass` is **forbidden** with everything pinned to `PriceClass_All`, and **the
   distribution cannot be deleted at all** until the plan is cancelled in the console.

   That last one makes teardown a two-phase operation whenever a distribution exists: cancel
   the plan, then run the teardown. Budget for it — `npm run destroy` cannot do it for you and
   cannot even detect it in advance.

   The upside is that WAF is already on, free, with three AWS managed rule groups
   (`CommonRuleSet`, `KnownBadInputsRuleSet`, `AmazonIpReputationList`) — so the "no WAF"
   hardening gap does not exist. The cost is that the rules are CloudFront's to change, not
   ours, and we cannot add a rate-based rule without taking ownership of the WebACL in CDK
   (which would likely start WAF billing at ~$5/month/environment). Revisit only if a
   CloudFront-side rate limit becomes necessary; API Gateway throttling covers the API today.
