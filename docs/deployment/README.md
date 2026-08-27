# Deployment docs

AWS deployment for Fantasy League (Milestone 3). Start here.

| Doc | What it's for | Audience |
|---|---|---|
| [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) | The technical spec: architecture, locked decisions, VPC/networking design, CDK resources, naming conventions, and the security/best-practice checklist. | Whoever builds the `infra/` CDK app. |
| [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) | The as-run record of the first prod deploy (2026-07-11): every exact command, the outputs, everyday operations, and known deviations/follow-ups. | Anyone redeploying, operating, or rebuilding. |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Plain-language, step-by-step guide to deploy (or rebuild) the whole stack from scratch via IaC. | Anyone deploying an environment. |
| [RELIABILITY_PLAN.md](RELIABILITY_PLAN.md) | Reference for availability, fault tolerance, and disaster recovery — targets, backups, recovery runbooks, monitoring. Not a near-term work item; ready for when reliability becomes a priority. | Whoever hardens the system later. |

**Stack in one line:** private RDS Postgres + VPC Lambdas + fck-nat NAT instance +
CloudFront/S3 static site + API Gateway HTTP API + Cognito, defined in AWS CDK.
Everything named `fantasy-league-<env>-*`, tagged, and grouped in the AWS console
under Resource Groups → `fantasy-league-<env>-resources`.

**How to deploy:** either `npm run deploy:all` locally (or the individual `deploy:*`
scripts — see the runbook's "Scripted deployment" table), or push to `release` on
GitHub once the one-time setup in DEPLOYMENT_RUNBOOK.md's "Release process" section is
complete. Infra deploys work two interchangeable ways: `deploy:infra` (CDK) and
`deploy:infra:cli` (synth → publish assets → plain `aws cloudformation deploy`).

**Status:** **LIVE as of 2026-08-17** — https://d3ktr55dnycetc.cloudfront.net. Prod was
live 2026-07-11 through 2026-07-13, torn down, then redeployed via the `main`→`release`
GitHub Actions pipeline (first successful end-to-end run of that pipeline — see
DEPLOYMENT_RUNBOOK.md's Troubleshooting rows 15-16 for the two bugs it took to get
there: an OIDC trust-policy/environment-claim mismatch, and SSM secrets that needed
re-seeding after the teardown). That run's infra step (`cdk deploy`) was accidentally
cancelled from the GitHub UI partway through — CloudFormation kept building regardless
(cancelling the workflow doesn't cancel the underlying stack operation) and reached
`CREATE_COMPLETE` on its own, but the workflow's remaining steps (migrate/frontend/
smoke) never ran as a result. Those three were finished manually with `npm run
deploy:migrate`, `deploy:frontend`, `deploy:smoke` — all passed. The account-level
`FantasyLeagueGitHubDeploy` stack (GitHub OIDC provider + deploy role) is also live,
and `release` has branch protection requiring `integration-smoke`.

**Since then (as of 2026-08-26):**
- **Prod carries real user data.** The GW1 beta launched 2026-08-21 — see
  [`../beta-launch-runbook.md`](../beta-launch-runbook.md) for the as-run record. Prod holds
  real users, leagues and teams plus 674 hydrated players. Treat every prod write as touching
  real people, and **snapshot before migrating** — the launch-night "prod is empty" shortcut
  no longer applies.
- **Match-poll schedule is ENABLED**, and the CDK default was inverted to on 2026-08-24 —
  previously any deploy omitting `--enable-match-poll` would silently disable a *running*
  schedule. See DEPLOYMENT_RUNBOOK.md follow-up 7.
- **The `production` required-reviewer rule is ON** (confirmed 2026-08-20), so prod deploys
  pause for approval. One approval releases the whole job — infra, migrations, frontend, smoke.
- **Prod runs pre-fix worker code.** Five worker-pipeline defects found in live use
  (remaining-gaps items 16-20) are closed in the tree but **not yet deployed**; that deploy also
  carries the unapplied migration `0013_glorious_lady_mastermind.sql`.

**Still open:** reserved concurrency quota, an undrilled restore (higher stakes now that prod
holds real data), and the rest of the ops hardening in
[`../remaining-gaps-todo.md`](../remaining-gaps-todo.md) item 13.
