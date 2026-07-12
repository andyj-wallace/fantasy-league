#!/usr/bin/env bash
# Ensures the six SSM SecureString parameters exist under /fantasy-league/<env>/.
# Idempotent: existing parameters are NEVER overwritten (the deliberate guard from the
# deployment plan) — rotation is an explicit, separate action:
#   aws ssm put-parameter --overwrite --region us-east-1 --name <full-name> --type SecureString --value ...
# (rotating db-password additionally requires a stack update to re-point RDS; see runbook).
#
# Usage: scripts/deployment-put-secrets.sh       (or: npm run deploy:secrets)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

read_env_file_value() {
  local value
  value="$(grep "^$1=" "${REPO_ROOT}/.env" 2>/dev/null | cut -d= -f2- || true)"
  [ -n "${value}" ] || fail ".env is missing $1 — needed to create ${SSM_CONFIG_PATH}/$2"
  printf '%s' "${value}"
}

ensure_parameter() {
  local parameter_name="$1" value_command="$2"
  local full_name="${SSM_CONFIG_PATH}/${parameter_name}"
  if aws ssm get-parameter --name "${full_name}" >/dev/null 2>&1; then
    ok "${full_name} already exists (left untouched)"
    return
  fi
  # Values are produced by a subshell and piped straight to AWS — never echoed.
  aws ssm put-parameter --name "${full_name}" --type SecureString \
    --value "$(eval "${value_command}")" >/dev/null
  ok "${full_name} created"
}

info "Ensuring SecureString parameters under ${SSM_CONFIG_PATH}/"

# Fresh randoms (hex/base64: safe for RDS password rules and URL composition)
ensure_parameter auth-token-secret "openssl rand -base64 48"
ensure_parameter db-password       "openssl rand -hex 24"
ensure_parameter db-app-password   "openssl rand -hex 24"

# Copied from local .env (the values already proven against the live services)
ensure_parameter football-data-api-key  "read_env_file_value FOOTBALL_DATA_API_KEY football-data-api-key"
ensure_parameter cognito-user-pool-id   "read_env_file_value COGNITO_USER_POOL_ID cognito-user-pool-id"
ensure_parameter cognito-app-client-id  "read_env_file_value COGNITO_APP_CLIENT_ID cognito-app-client-id"

echo
aws ssm get-parameters-by-path --path "${SSM_CONFIG_PATH}" --query "Parameters[].Name" --output text \
  | tr '\t' '\n' | sed 's/^/  /'
ok "Secrets ready."
