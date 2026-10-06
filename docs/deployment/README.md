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

**Status:** **TORN DOWN 2026-10-06** after the GW1-GW5 beta. Nothing is deployed, so
there is no live URL (the former CloudFront URL `https://d3ktr55dnycetc.cloudfront.net`
is dead). The code, the CDK app in `infra/` and these runbooks are unchanged, so the
whole stack can be rebuilt with `npm run deploy:all`. The RDS final snapshot
`fantasy-league-prod-final-20261006-151737` holds the real beta data (users, leagues,
teams, scores, 674 hydrated players) and is the only copy: keep it until you are certain
you will not restore, and restore from it per `RELIABILITY_PLAN.md` instead of
re-seeding. The `.github/workflows` CI and deploy pipelines were removed in the same
change, so pushing `release` no longer deploys anything; the release process in
DEPLOYMENT_RUNBOOK.md is historical until the workflows are restored from git history.

**History:** live 2026-07-11 through 2026-07-13, torn down, redeployed 2026-08-17 via
the `main`→`release` GitHub Actions pipeline (see DEPLOYMENT_RUNBOOK.md's Troubleshooting
rows 15-16 for the two bugs it took to get there), GW1 beta launched 2026-08-21 (see
[`../beta-launch-runbook.md`](../beta-launch-runbook.md)), then torn down again
2026-10-06.

**If you rebuild:**
- Run `npm run deploy:secrets` first: teardown deletes every `/fantasy-league/prod/*` SSM
  parameter (Troubleshooting row 16).
- The unapplied worker-pipeline fixes (remaining-gaps items 16-20) and migration
  `0013_glorious_lady_mastermind.sql` were never deployed to the old environment; a fresh
  deploy gets them. If restoring from the snapshot, run `deploy:migrate` afterwards.
- Match-poll schedule now defaults to ENABLED (DEPLOYMENT_RUNBOOK.md follow-up 7). Prod
  data is real, so snapshot before migrating once users exist again.
- The GitHub OIDC stack `FantasyLeagueGitHubDeploy` and the `CDKToolkit` bootstrap stack
  are account-level and are not part of the per-environment teardown: check whether they
  still exist before assuming a clean account.

**Still open:** reserved concurrency quota, an undrilled restore (now the only route back
to the beta data), and the rest of the ops hardening in
[`../remaining-gaps-todo.md`](../remaining-gaps-todo.md) item 13.
