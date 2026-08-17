#!/usr/bin/env bash
# Rotates the football-data-api-key SSM parameter, then forces the match-poll
# worker Lambda to cold-start so it picks up the new value immediately —
# loadRuntimeConfigFromSsm.ts only re-reads SSM once per cold start, so without
# this the old key stays cached in memory until AWS recycles the warm instance
# on its own schedule.
#
# Usage: update FOOTBALL_DATA_API_KEY in .env to the new key, then run:
#   scripts/rotate-football-data-api-key.sh   (or: npm run deploy:rotate-football-key)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account
require_command jq "brew install jq"

new_value="$(grep '^FOOTBALL_DATA_API_KEY=' "${REPO_ROOT}/.env" 2>/dev/null | cut -d= -f2-)"
[ -n "${new_value}" ] || fail ".env is missing FOOTBALL_DATA_API_KEY — put the new key there first."

parameter_name="${SSM_CONFIG_PATH}/football-data-api-key"
info "Rotating ${parameter_name}"
aws ssm put-parameter --overwrite --type SecureString \
  --name "${parameter_name}" --value "${new_value}" >/dev/null
ok "${parameter_name} updated"

function_name="$(get_stack_output MatchPollWorkerLambdaName)"
[ -n "${function_name}" ] || fail "Could not resolve MatchPollWorkerLambdaName from stack ${STACK_NAME}."

info "Forcing ${function_name} to cold-start so it re-reads SSM"
# Merge a fresh timestamp into the *existing* environment rather than replacing
# it outright — Environment.Variables on update-function-configuration is a full
# overwrite, and this Lambda's real config (SSM_CONFIG_PATH, DB_HOST, ...) would
# otherwise be wiped.
current_env="$(aws lambda get-function-configuration --function-name "${function_name}" \
  --query 'Environment.Variables' --output json)"
merged_env="$(printf '%s' "${current_env}" | jq --arg ts "$(date +%s)" '. + {FORCE_COLD_START: $ts}')"
aws lambda update-function-configuration --function-name "${function_name}" \
  --environment "{\"Variables\": ${merged_env}}" >/dev/null
aws lambda wait function-updated --function-name "${function_name}"
ok "${function_name} recycled — next invocation will read the rotated key"
