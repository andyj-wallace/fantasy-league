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

**How to deploy:** `npm run deploy:all` (or the individual `deploy:*` scripts — see
the runbook's "Scripted deployment" table). Infra deploys work two interchangeable
ways: `deploy:infra` (CDK) and `deploy:infra:cli` (synth → publish assets → plain
`aws cloudformation deploy`). CI/CD via GitHub Actions is still a planned follow-up.

**Status:** **DEPLOYED** (2026-07-11). The `infra/` CDK app exists and `fantasy-league-prod`
is live at https://d2dhnsmye25s6d.cloudfront.net — see DEPLOYMENT_RUNBOOK.md for the
as-run commands and open follow-ups (CI/CD, reserved concurrency quota, match-poll
schedule pending the API-Football plan decision).
