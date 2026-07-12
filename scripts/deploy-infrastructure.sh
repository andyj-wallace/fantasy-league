#!/usr/bin/env bash
# Deploys the fantasy-league stack, two interchangeable ways:
#
#   --via cdk   (default)  npx cdk diff  →  confirm  →  npx cdk deploy
#   --via cli              npx cdk synth →  npx cdk-assets publish  →  aws cloudformation deploy
#
# Both produce the identical CloudFormation stack from the same infra/ source. The cli
# path shows that CDK is "just" a template compiler: synth emits the template + an asset
# manifest, cdk-assets uploads the Lambda bundles to the bootstrap bucket, and plain
# `aws cloudformation deploy` does the rest. (--s3-bucket is required: the template is
# ~65 KB, past CloudFormation's 51,200-byte direct-body limit.)
#
# Context flags are auto-derived so past deploy failures can't recur:
#   - reservedConcurrency: enabled only when the account's Lambda quota allows it
#     (limit ≥ 103); a new account's limit of 10 used to fail the deploy outright.
#   - matchPollEnabled: off unless --enable-match-poll — the free API-Football plan
#     cannot serve current-season data, so the poller only burns quota (runbook item 7).
#
# Usage: scripts/deploy-infrastructure.sh [--via cdk|cli] [--enable-match-poll] [--yes]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

deploy_via="cdk"
enable_match_poll="false"
skip_confirmation="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --via) deploy_via="$2"; shift 2 ;;
    --enable-match-poll) enable_match_poll="true"; shift ;;
    --yes) skip_confirmation="true"; shift ;;
    *) fail "Unknown argument: $1 (usage: --via cdk|cli, --enable-match-poll, --yes)" ;;
  esac
done
[ "${deploy_via}" = "cdk" ] || [ "${deploy_via}" = "cli" ] || fail "--via must be 'cdk' or 'cli'"

context_args=(-c "env=${ENVIRONMENT_NAME}")
if lambda_reserved_concurrency_is_allowed; then
  info "Lambda quota allows reserved concurrency — enabling it"
  context_args+=(-c reservedConcurrency=true)
else
  info "Lambda quota too low for reserved concurrency — deploying without (see runbook)"
fi
if [ "${enable_match_poll}" = "true" ]; then
  info "Match-poll schedule will be ENABLED (make sure the API-Football plan supports the current season)"
  context_args+=(-c matchPollEnabled=true)
else
  info "Match-poll schedule stays disabled (pass --enable-match-poll once the data plan is sorted)"
fi

cd "${INFRA_DIR}"

if [ "${deploy_via}" = "cdk" ]; then
  info "Reviewing changes (cdk diff) — read this before confirming:"
  npx cdk diff "${context_args[@]}" || true # diff exits non-zero when differences exist
  if [ "${skip_confirmation}" != "true" ]; then
    printf 'Proceed with cdk deploy? [y/N] '
    read -r answer
    [ "${answer}" = "y" ] || [ "${answer}" = "Y" ] || fail "Aborted before deploy."
  fi
  npx cdk deploy "${context_args[@]}" --require-approval never --outputs-file cdk-outputs.json
else
  info "Synthesizing template + asset manifest (creates nothing in AWS)"
  npx cdk synth "${context_args[@]}" --quiet

  info "Publishing Lambda bundles to ${BOOTSTRAP_ASSETS_BUCKET}"
  npx cdk-assets publish -p "cdk.out/${CDK_STACK_CONSTRUCT_ID}.assets.json"

  info "Deploying via plain CloudFormation"
  aws cloudformation deploy \
    --stack-name "${STACK_NAME}" \
    --template-file "cdk.out/${CDK_STACK_CONSTRUCT_ID}.template.json" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --s3-bucket "${BOOTSTRAP_ASSETS_BUCKET}" --s3-prefix cli-deploy-templates \
    --no-fail-on-empty-changeset
fi

echo
info "Stack outputs:"
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
ok "Infrastructure deploy complete (${deploy_via} path)."
