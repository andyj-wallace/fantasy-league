#!/usr/bin/env bash
# Builds the static Next.js export with the production env baked in, uploads it to the
# web bucket, and invalidates CloudFront. Run for every frontend change.
#
# Build-time values come from authoritative sources, not hardcoding:
#   - Cognito ids from SSM (the same values the API Lambda uses)
#   - bucket + distribution id from the live stack's outputs
#   - API base is "/api": same-origin through CloudFront, so no CORS
#
# Usage: scripts/publish-frontend.sh             (or: npm run deploy:frontend)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

web_bucket_name="$(get_stack_output WebBucketName)"
distribution_id="$(get_stack_output CloudFrontDistributionId)"
site_url="$(get_stack_output CloudFrontUrl)"
[ -n "${web_bucket_name}" ] && [ -n "${distribution_id}" ] || fail "Could not resolve stack outputs from ${STACK_NAME}."

info "Building static export (NEXT_PUBLIC_* baked in at build time)"
cd "${REPO_ROOT}"
NEXT_PUBLIC_API_BASE_URL="/api" \
NEXT_PUBLIC_COGNITO_USER_POOL_ID="$(get_ssm_parameter cognito-user-pool-id)" \
NEXT_PUBLIC_COGNITO_APP_CLIENT_ID="$(get_ssm_parameter cognito-app-client-id)" \
  npm run build

info "Syncing ./out → s3://${web_bucket_name}"
aws s3 sync ./out "s3://${web_bucket_name}" --delete --only-show-errors

info "Invalidating CloudFront (${distribution_id})"
aws cloudfront create-invalidation --distribution-id "${distribution_id}" \
  --paths "/*" --query "Invalidation.Id" --output text

ok "Frontend published: ${site_url}"
