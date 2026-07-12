#!/usr/bin/env bash
# Verifies a deployment end-to-end (the checks from DEPLOYMENT_PLAN.md §Verification).
# Read-only; safe to run anytime.
#
# Usage: scripts/deployment-smoke-test.sh        (or: npm run deploy:smoke)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

site_url="$(get_stack_output CloudFrontUrl)"
[ -n "${site_url}" ] || fail "Could not resolve CloudFrontUrl from stack ${STACK_NAME}."

failures=0
expect_http_status() {
  local description="$1" url="$2"; shift 2
  local actual_status
  actual_status="$(curl -sS -o /dev/null -w '%{http_code}' "${url}")"
  for expected in "$@"; do
    if [ "${actual_status}" = "${expected}" ]; then
      ok "${description}: HTTP ${actual_status}"
      return
    fi
  done
  warn "${description}: HTTP ${actual_status} (expected: $*) — ${url}"
  failures=$((failures + 1))
}

info "Smoke-testing ${site_url}"

# 401 (not 404/CORS/5xx) proves CloudFront → API Gateway → Lambda → SSM → auth provider.
expect_http_status "API via CloudFront (/api/gameweeks/current)" "${site_url}/api/gameweeks/current" 401 200
# Extensionless page URL proves the CloudFront url-rewrite Function.
expect_http_status "URL rewrite (/login)" "${site_url}/login" 200
expect_http_status "Site root (/)" "${site_url}/" 200

database_is_public="$(aws rds describe-db-instances \
  --db-instance-identifier "${STACK_NAME}-db" \
  --query "DBInstances[0].PubliclyAccessible" --output text)"
if [ "${database_is_public}" = "False" ]; then
  ok "RDS is not publicly accessible"
else
  warn "RDS PubliclyAccessible=${database_is_public} — investigate immediately"
  failures=$((failures + 1))
fi

match_poll_rule_state="$(aws events describe-rule --name "${STACK_NAME}-match-poll" \
  --query State --output text 2>/dev/null || echo "MISSING")"
info "Match-poll schedule state: ${match_poll_rule_state} (DISABLED is expected until the API-Football plan supports the current season)"

echo
if [ "${failures}" -eq 0 ]; then
  ok "All smoke tests passed."
else
  fail "${failures} smoke test(s) failed."
fi
