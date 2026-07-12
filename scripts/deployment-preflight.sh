#!/usr/bin/env bash
# Verifies everything the deployment needs BEFORE anything touches AWS state.
# Every check here exists because its absence bit us (or nearly did) on the first
# prod deploy — see docs/deployment/DEPLOYMENT_RUNBOOK.md "Troubleshooting".
#
# Usage: scripts/deployment-preflight.sh        (or: npm run deploy:preflight)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"

hard_failures=0
check_failed() { warn "$1"; hard_failures=$((hard_failures + 1)); }

info "Preflight for ${STACK_NAME} in ${DEPLOYMENT_REGION} (account ${DEPLOYMENT_ACCOUNT_ID})"

# 1. Tooling
require_command aws "Install the AWS CLI v2."
require_command node "Install Node.js (see .nvmrc / package.json engines)."
node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "${node_major}" -ge 20 ] && ok "node $(node --version)" || check_failed "Node >= 20 required, found $(node --version)"

# 2. Credentials + account (wrong account = a parallel set of resources)
require_correct_aws_account
ok "AWS credentials valid, account ${DEPLOYMENT_ACCOUNT_ID}"

# 3. Region awareness — the CLI default on this machine is historically us-east-2;
#    scripts export AWS_DEFAULT_REGION, but hand-typed commands must pass --region.
configured_default_region="$(aws configure get region 2>/dev/null || true)"
if [ -n "${configured_default_region}" ] && [ "${configured_default_region}" != "${DEPLOYMENT_REGION}" ]; then
  warn "Your CLI default region is '${configured_default_region}' but the stack lives in '${DEPLOYMENT_REGION}'."
  warn "Scripts handle this; add --region ${DEPLOYMENT_REGION} to any command you type by hand."
else
  ok "CLI default region matches (${DEPLOYMENT_REGION})"
fi

# 4. infra dependencies installed (cdk CLI, aws-cdk-lib, cdk-assets, esbuild)
if [ -d "${INFRA_DIR}/node_modules/aws-cdk-lib" ]; then
  ok "infra/ dependencies installed"
else
  check_failed "infra/ dependencies missing — run: cd infra && npm install"
fi

# 5. CDK bootstrap present in this account+region
if aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version >/dev/null 2>&1; then
  ok "CDK bootstrapped (CDKToolkit present)"
else
  check_failed "CDK not bootstrapped — run: cd infra && npx cdk bootstrap aws://${DEPLOYMENT_ACCOUNT_ID}/${DEPLOYMENT_REGION}"
fi

# 6. All six SSM secrets exist (created out-of-band; the stack only reads them)
required_parameters=(auth-token-secret db-password db-app-password
  football-data-api-key cognito-user-pool-id cognito-app-client-id)
missing_parameters=()
for parameter_name in "${required_parameters[@]}"; do
  aws ssm get-parameter --name "${SSM_CONFIG_PATH}/${parameter_name}" >/dev/null 2>&1 \
    || missing_parameters+=("${parameter_name}")
done
if [ ${#missing_parameters[@]} -eq 0 ]; then
  ok "All 6 SSM parameters exist under ${SSM_CONFIG_PATH}/"
else
  check_failed "Missing SSM parameters: ${missing_parameters[*]} — run: scripts/deployment-put-secrets.sh"
fi

# 7. Lambda concurrency quota → decides the reservedConcurrency context flag
if lambda_reserved_concurrency_is_allowed; then
  ok "Lambda concurrency quota allows reserved concurrency (deploy scripts will enable it)"
else
  warn "Lambda account concurrency limit < 103 — reserved concurrency stays OFF (harmless;"
  warn "the worker's DB gate provides overlap safety). To fix permanently: Service Quotas →"
  warn "'Concurrent executions' (L-B99A9384) → request 1000, then redeploy."
fi

# 8. session-manager-plugin — only needed for the DB tunnel, so warn, don't fail
if command -v session-manager-plugin >/dev/null 2>&1; then
  ok "session-manager-plugin available ($(session-manager-plugin --version))"
else
  warn "session-manager-plugin not installed — needed only for scripts/open-database-tunnel.sh"
  warn "(it can install itself on first run, or: brew install --cask session-manager-plugin)"
fi

echo
if [ "${hard_failures}" -eq 0 ]; then
  ok "Preflight passed."
else
  fail "Preflight found ${hard_failures} blocking issue(s) — fix them before deploying."
fi
