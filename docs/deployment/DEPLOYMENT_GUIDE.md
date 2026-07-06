# Deployment Guide — Deploy Fantasy League from Scratch

Plain-language, step-by-step. 
Goal: anyone on the team can stand up (or rebuild)
the whole system in one sitting, because everything is Infrastructure as Code (IaC).
You describe the infrastructure in code (AWS CDK), and one command builds it all. No
clicking around the AWS console.

If you only read one thing: **the entire stack is created and destroyed with
`cdk deploy` and `cdk destroy`. Nothing is set up by hand.** That is what makes it
repeatable.

See `DEPLOYMENT_PLAN.md` for the full technical spec and `RELIABILITY_PLAN.md` for
backups and recovery.

---

## What you're building (in one picture)

A website (static files on CloudFront/S3), an API and background jobs (AWS Lambda
functions), and a database (RDS Postgres) — all inside one private network (a VPC),
with a tiny "NAT instance" that lets the background jobs reach the football data
provider on the internet. Users log in through Cognito. Everything is named
`fantasy-league-<env>-...` so it's easy to find.

`<env>` is the environment: `dev`, `staging`, or `prod`. You deploy the same code to
each — only the name changes.

---

## Before you start (one-time prerequisites)

You need these installed and set up **once**:

1. **An AWS account** you can deploy into, and the **AWS CLI** configured
   (`aws configure`) with credentials that can create resources.
2. **Node.js** (same version the project uses) and the repo cloned.
3. **AWS CDK** installed: `npm install -g aws-cdk`.
4. Run `npm ci` in the repo root to install dependencies.

You'll know it's working when `aws sts get-caller-identity` prints your account ID.

---

## Step-by-step: first-time deployment

Work from the repo root. Commands are illustrative — the exact flags live in the
`infra/` app.

### Step 1 — Prepare the CDK app (one-time per account)

CDK needs a small amount of supporting infrastructure in your account before its
first use. This is called "bootstrapping":

```
cd infra
npm ci
cdk bootstrap aws://<account-id>/us-east-1
```

You only do this once per account+region.

### Step 2 — Put your secrets in AWS (one-time per environment)

Secrets never live in the code. Store them in AWS SSM Parameter Store under the
`/fantasy-league/<env>/` path. For example, for prod:

```
aws ssm put-parameter --name /fantasy-league/prod/auth-token-secret \
    --type SecureString --value "<a long random string>"
aws ssm put-parameter --name /fantasy-league/prod/football-data-api-key \
    --type SecureString --value "<your API-Football key>"
aws ssm put-parameter --name /fantasy-league/prod/cognito-user-pool-id \
    --type SecureString --value "us-east-1_DBETCnAJP"
aws ssm put-parameter --name /fantasy-league/prod/cognito-app-client-id \
    --type SecureString --value "8rv8u5ctrdranj2ev6d0en122"
```

(The database connection string is created automatically by the stack from the RDS
credentials — you don't set it by hand.)

### Step 3 — Build the whole stack

One command creates the network, database, NAT instance, all the Lambda functions,
the API gateway, and the website hosting:

```
cdk deploy fantasy-league-prod
```

This takes ~15–20 minutes the first time (the database and network take the longest).
When it finishes, CDK prints the outputs you need — most importantly the **CloudFront
URL** (your live site) and the names of the Lambda functions.

### Step 4 — Create the database tables

The database starts empty. Run the migration Lambda once to create the schema:

```
aws lambda invoke --function-name fantasy-league-prod-migrate /dev/stdout
```

You should see a success summary. (In normal operation, CI does this automatically
after every deploy — see Step 7.)

### Step 5 — Load player data

Populate the players table using the existing hydration path (subject to your
API-Football plan limits — see `remaining-gaps-todo.md` item 6). For a first run you
can use the seed data to verify the flow end to end.

### Step 6 — Publish the website

Build the static site and upload it, then clear the CloudFront cache so visitors get
the new version:

```
npm run build                 # produces ./out
aws s3 sync ./out s3://fantasy-league-prod-web-<account-id> --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

Open the CloudFront URL from Step 3 — the site is live.

### Step 7 — Turn on automatic deployments (recommended)

After the first manual run, let GitHub Actions do Steps 3, 4, and 6 automatically on
every push to `main`. It authenticates to AWS with OIDC (no stored AWS keys). See the
CI/CD section of `DEPLOYMENT_PLAN.md`. From then on, deploying is just:

```
git push origin main
```

---

## How to deploy a second environment (e.g. staging)

Because it's all code, a new environment is the same commands with a different `<env>`:

```
# put staging secrets under /fantasy-league/staging/...
cdk deploy fantasy-league-staging
aws lambda invoke --function-name fantasy-league-staging-migrate /dev/stdout
```

Same code, isolated resources, separate database. Nothing is copied by hand.

---

## Everyday operations

- **Ship a change:** push to `main` (CI deploys) — or run `cdk deploy` locally.
- **See what a change will do before applying it:** `cdk diff` shows exactly which
  resources would be added/changed/removed. Always look at this for infra changes.
- **Roll back:** re-deploy the previous git commit (`git revert` then push), or
  `cdk deploy` from an earlier checkout. Infra and code roll back together.
- **Read logs:** each Lambda logs to a CloudWatch log group named after the function
  (`/aws/lambda/fantasy-league-prod-api`, etc.).
- **Tear it all down (non-prod):** `cdk destroy fantasy-league-dev`. Prod has deletion
  protection on the database, on purpose — see the reliability plan before touching it.

---

## Why this is repeatable and fast

- **One source of truth.** The `infra/` CDK app is the only definition of the
  infrastructure. What's deployed always matches the code.
- **No manual console steps.** If it's not in CDK, it doesn't exist. This is why a
  rebuild is a single command, not a day of clicking.
- **Same code, many environments.** dev/staging/prod differ only by an `<env>` name.
- **Recovery is a deploy.** If an environment is lost, `cdk deploy` recreates the
  infrastructure and the database is restored from a snapshot (see
  `RELIABILITY_PLAN.md`). There is no hand-built state to reconstruct from memory.
