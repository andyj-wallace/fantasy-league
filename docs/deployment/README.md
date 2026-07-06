# Deployment docs

AWS deployment for Fantasy League (Milestone 3). Start here.

| Doc | What it's for | Audience |
|---|---|---|
| [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) | The technical spec: architecture, locked decisions, VPC/networking design, CDK resources, naming conventions, and the security/best-practice checklist. | Whoever builds the `infra/` CDK app. |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Plain-language, step-by-step guide to deploy (or rebuild) the whole stack from scratch via IaC. | Anyone deploying an environment. |
| [RELIABILITY_PLAN.md](RELIABILITY_PLAN.md) | Reference for availability, fault tolerance, and disaster recovery — targets, backups, recovery runbooks, monitoring. Not a near-term work item; ready for when reliability becomes a priority. | Whoever hardens the system later. |

**Stack in one line:** private RDS Postgres + VPC Lambdas + fck-nat NAT instance +
CloudFront/S3 static site + API Gateway HTTP API + Cognito, defined in AWS CDK,
deployed via GitHub Actions. Everything named `fantasy-league-<env>-*`.

**Status:** spec/reference only — the `infra/` CDK app is not yet built.
