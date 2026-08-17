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

**Status:** **App stack NOT DEPLOYED; CI/CD infra is.** Prod was live 2026-07-11
through 2026-07-13, then fully torn down (stack, VPC, database, snapshot, bucket, SSM
params — see DEPLOYMENT_RUNBOOK.md's Teardown section, including the 2026-07-13 as-run
incident and fix) and hasn't been redeployed since. Separately, as of 2026-08-16 the
account-level `FantasyLeagueGitHubDeploy` stack (GitHub OIDC provider + deploy role) is
live, and `release` has branch protection requiring `integration-smoke` — see
DEPLOYMENT_RUNBOOK.md's Release process section for what's still open (the
`production` environment's required-reviewer rule) before a `release` push can be
trusted to deploy unattended. Before the *first* deploy attempt since the teardown,
run `npm run deploy:secrets` — the teardown deleted every `/fantasy-league/prod/*` SSM
parameter and nothing recreates them automatically (see runbook Troubleshooting row
16). The `infra/` CDK app itself is production-ready — see DEPLOYMENT_RUNBOOK.md for
the as-run commands and remaining open follow-ups (reserved concurrency quota,
match-poll schedule pending the API-Football plan decision).
