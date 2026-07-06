# Reliability Plan — Availability, Fault Tolerance & Disaster Recovery

Status: **reference document, not a near-term work item.** This exists so that when
availability matters (real users, or a growth push), the plan is already written and
can be executed deliberately rather than improvised. It also states which safeguards
are on from day one versus which are documented upgrade paths.

Scope: the AWS stack described in `DEPLOYMENT_PLAN.md` (private RDS + VPC Lambdas +
fck-nat NAT instance + CloudFront/S3 + Cognito). Naming follows
`fantasy-league-<env>-*`.

---

## 1. Availability targets (informal SLOs)

For a small-scale MVP these are goals, not contractual SLAs. They set the bar the
design must clear and tell us where to invest first.

| Surface | Target | Rationale |
|---|---|---|
| Website (read) | 99.9% | Static on CloudFront/S3 — inherently highly available |
| API (login, squad, transfers) | 99% | Lambda + RDS; single-AZ DB is the limiting factor |
| Leaderboard/standings read | 99% | Served from precomputed tables; no live compute |
| Scoring/data pipeline (worker) | Best-effort | Idempotent; a missed cycle self-corrects next tick |

**Key architectural advantage:** the "calculate once, store forever" pattern means
**user-facing reads never depend on the worker or the football provider being up.**
Standings are a flat `SELECT` from a precomputed table. So a data-pipeline outage
degrades *freshness*, not *availability*, of the site.

---

## 2. Fault tolerance — component by component

What happens when each piece fails, and what protects us.

| Component | Failure mode | Protection today | Documented upgrade |
|---|---|---|---|
| **CloudFront + S3** | AWS edge/region issue | Multi-AZ + global edge by default; very high HA | none needed |
| **API Lambda** | Instance/AZ failure | Stateless; runs across **2 AZs**; AWS auto-retries | none needed |
| **Worker/price Lambda** | Crash or timeout | Idempotent upserts; **retries next schedule**; no data loss | DLQ + alarm on repeated failure |
| **RDS Postgres** | AZ failure / instance loss | **Single-AZ today** — this is the main SPOF. Automated backups + PITR | **Enable Multi-AZ** (auto-failover in 1–2 min) |
| **NAT instance (fck-nat)** | Instance dies | **ASG size 1 relaunches + reattaches ENI (~2–4 min)**; only affects worker egress, invisible to users | Second NAT (per-AZ) or managed NAT Gateway |
| **Cognito** | AWS service issue | AWS-managed, multi-AZ, highly durable | none needed |
| **SSM Parameter Store** | Read failure at cold start | Values also cached in warm Lambdas; rare | none needed |

**Deliberate single points of failure (accepted for cost at MVP scale):**
1. **Single-AZ RDS** — an AZ outage takes the database (and thus the API) down until
   the AZ recovers or we restore. Upgrade to Multi-AZ is a one-property CDK change
   when uptime justifies ~2× DB cost.
2. **Single NAT instance** — but its blast radius is only the background data
   pipeline, which is already retry-tolerant, so this is low-risk by design.

---

## 3. Disaster recovery (DR)

"Disaster" = an environment is lost or corrupted (bad migration, region issue,
accidental deletion, data corruption).

### Recovery objectives

| Metric | Target (MVP) | Meaning |
|---|---|---|
| **RTO** (time to restore service) | ≤ 4 hours | How long to be back up |
| **RPO** (acceptable data loss) | ≤ 24 hours (≤ 5 min with PITR) | How much recent data we can lose |

These are comfortably achievable because **infrastructure is disposable and
code-defined** — only the database and the identity store hold irreplaceable state.

### What is stateful (what actually needs protecting)

- **RDS database** — the only application state. Protected by automated backups.
- **Cognito user pool** — identity source of truth (DB holds a synced copy: `cognito_sub`,
  `handle`). AWS-managed and durable; export users periodically as a precaution.
- **SSM secrets** — re-creatable, but keep a secure offline copy of the source values.

Everything else (VPC, Lambdas, API, CloudFront, NAT) is **rebuilt from CDK in one
command** and holds no state.

### Backup strategy (RDS)

- **Automated daily backups** with **7-day retention** (raise to 14–30 for prod).
- **Point-in-time recovery (PITR)** enabled → restore to any second within the
  retention window (this is what makes real RPO ~5 min, not 24 h).
- **Manual snapshot before every schema migration** (name it
  `fantasy-league-prod-pre-migrate-<date>`). Cheap insurance against a bad migration.
- **Prod: deletion protection ON + final snapshot on delete** — you cannot fat-finger
  the database away.
- **Optional regional DR:** copy the latest snapshot to a second region on a schedule
  so a whole-region loss is recoverable.

### Recovery runbooks

**A. Bad migration / data corruption**
1. Stop writes (disable the worker's EventBridge rule).
2. Restore RDS to a new instance from the pre-migration snapshot or a PITR timestamp.
3. Point the app at the restored instance (update the SSM `database-url`, redeploy).
4. Re-enable the worker. Verify standings recompute cleanly.

**B. Whole environment lost**
1. `cdk deploy fantasy-league-<env>` — recreates all infrastructure (~15–20 min).
2. Restore the database from the latest snapshot into the new stack.
3. Re-publish the frontend (`s3 sync` + CloudFront invalidation).
4. Verify with the smoke test in `DEPLOYMENT_PLAN.md`.

**C. AZ outage (single-AZ RDS)**
- Short outage: wait for AZ recovery. Long outage: restore latest snapshot into a
  healthy AZ (RTO ≈ under an hour). **This is the scenario Multi-AZ eliminates** —
  enable it if this risk becomes unacceptable.

**D. NAT instance down**
- Usually self-heals via the ASG. If not: the ASG will relaunch on the next health
  check; worst case, `cdk deploy` re-creates it. No user impact meanwhile; the worker
  catches up on the next successful poll.

**E. Region-wide outage**
- Only with the optional cross-region snapshot copy: deploy the CDK app to the DR
  region and restore the copied snapshot. Without it, wait for region recovery
  (accepted risk at MVP scale — document the decision explicitly).

---

## 4. Monitoring & alerting (the trigger for all of the above)

DR plans are useless if no one knows something broke. This ties into the M3
"monitoring" gap and should ship alongside real availability work.

**Minimum alarms (CloudWatch → SNS → email/Slack):**
- RDS: CPU high, **free storage low**, **free connections low**, instance unhealthy.
- Lambda: error rate / throttles on `fantasy-league-<env>-api`; repeated failures on
  the worker (via a DLQ depth alarm).
- NAT instance: ASG unhealthy-host / instance-recycle events.
- CloudFront: elevated 5xx rate.
- **AWS Budgets alarm** on the `Project=fantasy-league` tag — catches a runaway cost
  (e.g. someone swaps the NAT instance for a Gateway, or a loop hammers the provider).

**Health signal:** a lightweight `/api/gameweeks/current` check from an external
uptime monitor is a good end-to-end canary (exercises CloudFront → API → RDS).

---

## 5. Readiness checklist (when we decide to "make it reliable")

Ordered by value-for-effort. None required for the initial MVP launch; all defined
so they can be turned on deliberately.

- [ ] Enable **RDS Multi-AZ** (removes the biggest SPOF).
- [ ] Raise backup retention to 14–30 days; verify a **test restore** actually works.
- [ ] Add the **CloudWatch alarms + SNS** above and the **Budgets** alarm.
- [ ] Add a **Dead Letter Queue** to the worker Lambdas + alarm on depth.
- [ ] Add an external **uptime canary** on `/api/gameweeks/current`.
- [ ] Schedule **cross-region snapshot copy** if regional DR is required.
- [ ] Run a **game-day**: deliberately kill the NAT instance and restore the DB from a
      snapshot in staging, timing it against the RTO target.
- [ ] Consider a **second NAT instance** (per-AZ) only if worker freshness becomes
      business-critical.
