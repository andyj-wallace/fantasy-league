#!/usr/bin/env bash
# Shared configuration + helpers sourced by every deployment script.
#
# Guardrails baked in from the first prod deploy (2026-07-11) — see
# docs/deployment/DEPLOYMENT_RUNBOOK.md "Troubleshooting" for the full stories:
#   - The stack lives in us-east-1 but this machine's AWS CLI default is us-east-2,
#     so AWS_DEFAULT_REGION is exported here and every script inherits it.
#   - session-manager-plugin may live in ~/.local/bin (no-sudo install), which is
#     not on the default PATH — appended here.
#   - The wrong AWS account would create a parallel universe of resources —
#     require_correct_aws_account aborts before any script can touch AWS.

DEPLOYMENT_ACCOUNT_ID="345482189946"
DEPLOYMENT_REGION="us-east-1" # locked: the live Cognito pool us-east-1_DBETCnAJP lives here
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-prod}"
STACK_NAME="fantasy-league-${ENVIRONMENT_NAME}"
CDK_STACK_CONSTRUCT_ID="FantasyLeague-$(printf '%s' "${ENVIRONMENT_NAME:0:1}" | tr '[:lower:]' '[:upper:]')${ENVIRONMENT_NAME:1}"
SSM_CONFIG_PATH="/fantasy-league/${ENVIRONMENT_NAME}"
# The CDK bootstrap assets bucket ("hnb659fds" is CDK's fixed default qualifier).
BOOTSTRAP_ASSETS_BUCKET="cdk-hnb659fds-assets-${DEPLOYMENT_ACCOUNT_ID}-${DEPLOYMENT_REGION}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"

export AWS_DEFAULT_REGION="${DEPLOYMENT_REGION}"
export PATH="${HOME}/.local/bin:${PATH}"

info() { printf '· %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed. $2"
}

require_correct_aws_account() {
  local actual_account
  actual_account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || fail "AWS credentials are not working — run 'aws configure' / check your session."
  [ "${actual_account}" = "${DEPLOYMENT_ACCOUNT_ID}" ] \
    || fail "AWS credentials point at account ${actual_account}, expected ${DEPLOYMENT_ACCOUNT_ID}."
}

get_stack_output() {
  aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

get_ssm_parameter() {
  aws ssm get-parameter --name "${SSM_CONFIG_PATH}/$1" --with-decryption \
    --query Parameter.Value --output text
}

# Reserved concurrency needs (account limit − 3 reservations) ≥ 100 — new accounts
# start at 10, which forbids any reservation (learned on the first deploy).
lambda_reserved_concurrency_is_allowed() {
  local account_concurrency_limit
  account_concurrency_limit="$(aws lambda get-account-settings \
    --query AccountLimit.ConcurrentExecutions --output text)"
  [ "${account_concurrency_limit}" -ge 103 ]
}
