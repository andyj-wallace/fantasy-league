#!/usr/bin/env bash
# The whole deployment, in order: preflight → secrets → infrastructure → migrations →
# frontend → smoke tests. Each step is the standalone script, so this is also the
# documentation of the correct sequence. Idempotent: secrets are never overwritten,
# CloudFormation no-ops on an unchanged template, migrations skip what's applied,
# and the frontend sync only uploads changes.
#
# Not included (deliberately): mock-data seeding — a one-time, first-deploy action
# (scripts/open-database-tunnel.sh + npm run seed:mock; see the runbook).
#
# Usage: scripts/deploy-everything.sh [--via cdk|cli] [--enable-match-poll]
#        (or: npm run deploy:all / deploy:all:cli)
set -euo pipefail
script_directory="$(dirname "${BASH_SOURCE[0]}")"

deploy_via="cdk"
extra_infra_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --via) deploy_via="$2"; shift 2 ;;
    --enable-match-poll) extra_infra_args+=(--enable-match-poll); shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

"${script_directory}/deployment-preflight.sh"
"${script_directory}/deployment-put-secrets.sh"
"${script_directory}/deploy-infrastructure.sh" --via "${deploy_via}" --yes "${extra_infra_args[@]+"${extra_infra_args[@]}"}"
"${script_directory}/run-database-migrations.sh"
"${script_directory}/publish-frontend.sh"
"${script_directory}/deployment-smoke-test.sh"
