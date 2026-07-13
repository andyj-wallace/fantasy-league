#!/usr/bin/env bash
# Tears down a fantasy-league environment COMPLETELY — the CloudFormation stack plus
# everything a plain `cdk destroy` deliberately leaves behind — in the order that
# avoids stuck deletes and orphaned, still-billing resources.
#
# Why a plain destroy is NOT enough (see runbook §Teardown for the full story):
#   - the web S3 bucket is RemovalPolicy.RETAIN → abandoned, keeps billing storage
#   - the prod RDS instance is RETAIN + deletion-protected → keeps billing ~$14/mo
#   - the prod RDS instance's auto-created DB subnet group inherits that same RETAIN
#     policy → always orphaned, regardless of ordering (see step 6)
#   - the six SSM parameters were created out-of-band → the stack never owned them
#   - prod has stack termination protection → delete-stack is refused outright
#   - the RDS final snapshot (taken here on purpose) persists until deleted
#
# Ordering matters: a RETAINed RDS instance is left running with its ENI still attached
# to the DB security group, parameter group, and one VPC subnet. If the stack delete runs
# while that instance is still alive, CloudFormation deletes everything else first and
# THEN fails on those three — DELETE_FAILED, requiring a manual retry. So the database is
# deleted BEFORE the stack, not after: by the time cdk destroy runs, nothing is still
# using those resources and the delete succeeds in one pass. The now-empty bucket and the
# orphaned subnet group are cleaned up after, since the stack never owned the bucket and
# will never willingly delete the RETAINed subnet group either way.
#
# SAFE BY DEFAULT: with no flags this only PRINTS the teardown plan (read-only).
#
#   scripts/destroy-environment.sh                       # show the plan
#   scripts/destroy-environment.sh --execute             # destroy (typed confirmation)
#   --via cdk|cli        stack deletion via cdk destroy (default) or plain CloudFormation
#   --no-final-snapshot  skip the RDS final snapshot (default: take one)
#
# Destroying PROD additionally requires ALLOW_PROD_DESTROY=yes in the environment.
# Never touched by this script: the Cognito user pool (imported, shared, live) and the
# CDKToolkit bootstrap stack (see runbook appendix if abandoning CDK in this account).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

execute="false"
destroy_via="cdk"
final_snapshot="true"
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) execute="true"; shift ;;
    --via) destroy_via="$2"; shift 2 ;;
    --no-final-snapshot) final_snapshot="false"; shift ;;
    *) fail "Unknown argument: $1 (usage: [--execute] [--via cdk|cli] [--no-final-snapshot])" ;;
  esac
done
[ "${destroy_via}" = "cdk" ] || [ "${destroy_via}" = "cli" ] || fail "--via must be 'cdk' or 'cli'"

# Physical names are deterministic by convention (fantasy-league-<env>-*), so the
# sweep works even after the stack — and its outputs — are gone.
database_identifier="${STACK_NAME}-db"
web_bucket_name="fantasy-league-${ENVIRONMENT_NAME}-web-${DEPLOYMENT_ACCOUNT_ID}"
final_snapshot_identifier="${STACK_NAME}-final-$(date +%Y%m%d-%H%M%S)"
ssm_parameter_names=(auth-token-secret db-password db-app-password
  football-data-api-key cognito-user-pool-id cognito-app-client-id)

stack_exists="false"
aws cloudformation describe-stacks --stack-name "${STACK_NAME}" >/dev/null 2>&1 && stack_exists="true"
database_exists="false"
aws rds describe-db-instances --db-instance-identifier "${database_identifier}" >/dev/null 2>&1 && database_exists="true"
bucket_exists="false"
aws s3api head-bucket --bucket "${web_bucket_name}" >/dev/null 2>&1 && bucket_exists="true"

# Neither the VPC nor the DB's auto-created subnet group has a deterministic name (no
# instanceIdentifier-style override in the CDK code, unlike the database and bucket), so
# grab their physical IDs from the stack while it still owns them — this is the only
# reliable way to name them once the stack is gone.
vpc_physical_id=""
db_subnet_group_physical_id=""
if [ "${stack_exists}" = "true" ]; then
  vpc_physical_id="$(aws cloudformation list-stack-resources --stack-name "${STACK_NAME}" \
    --query "StackResourceSummaries[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" --output text)"
  db_subnet_group_physical_id="$(aws cloudformation list-stack-resources --stack-name "${STACK_NAME}" \
    --query "StackResourceSummaries[?ResourceType=='AWS::RDS::DBSubnetGroup'].PhysicalResourceId" --output text)"
fi

echo "Teardown plan for environment '${ENVIRONMENT_NAME}' (account ${DEPLOYMENT_ACCOUNT_ID}, ${DEPLOYMENT_REGION})"
echo
echo "  Current state: stack=$([ "${stack_exists}" = true ] && echo EXISTS || echo absent)," \
     "database=$([ "${database_exists}" = true ] && echo EXISTS || echo absent)," \
     "web bucket=$([ "${bucket_exists}" = true ] && echo EXISTS || echo absent)"
echo
echo "  1. Empty the web bucket (retained buckets still bill for storage)"
echo "       aws s3 rm s3://${web_bucket_name} --recursive"
if [ "${ENVIRONMENT_NAME}" = "prod" ]; then
  echo "  2. Disable stack termination protection (prod refuses deletion otherwise)"
  echo "       aws cloudformation update-termination-protection --stack-name ${STACK_NAME} --no-enable-termination-protection"
  echo "  3. Disable RDS deletion protection (prod)"
  echo "       aws rds modify-db-instance --db-instance-identifier ${database_identifier} --no-deletion-protection --apply-immediately"
  echo "  4. Delete the database FIRST (if present)$([ "${final_snapshot}" = true ] && echo " — WITH final snapshot ${final_snapshot_identifier}")"
  echo "     Must happen before the stack delete: the live instance's ENI still occupies the"
  echo "     DB security group, parameter group, and a VPC subnet, and CloudFormation cannot"
  echo "     delete any of those while it's running."
  if [ "${final_snapshot}" = "true" ]; then
    echo "       aws rds delete-db-instance --db-instance-identifier ${database_identifier} --final-db-snapshot-identifier ${final_snapshot_identifier}"
  else
    echo "       aws rds delete-db-instance --db-instance-identifier ${database_identifier} --skip-final-snapshot"
  fi
else
  echo "  2. (skip — no termination protection outside prod)"
  echo "  3. (skip — no RDS deletion protection outside prod)"
  echo "  4. (skip — non-prod database is RemovalPolicy.DESTROY, the stack delete handles it)"
fi
echo "  5. Delete the stack — removes the remaining ~60 stack-owned resources (VPC, security"
echo "     groups, subnets, Lambdas, API Gateway, ...); CloudFront disable+delete is the slow"
echo "     part (10–20 min). The DB's auto-created subnet group is skipped, not deleted — it"
echo "     inherits the same RETAIN policy as the instance (see step 6)."
if [ "${destroy_via}" = "cdk" ]; then
  echo "       cd infra && npx cdk destroy ${CDK_STACK_CONSTRUCT_ID} -c env=${ENVIRONMENT_NAME} --force"
else
  echo "       aws cloudformation delete-stack --stack-name ${STACK_NAME}"
  echo "       aws cloudformation wait stack-delete-complete --stack-name ${STACK_NAME}"
fi
echo "  6. Delete the orphaned DB subnet group left behind by step 5$([ -n "${db_subnet_group_physical_id}" ] && echo " (${db_subnet_group_physical_id})")"
echo "       aws rds delete-db-subnet-group --db-subnet-group-name <captured above>"
echo "  7. Delete the (now empty) retained web bucket"
echo "       aws s3 rb s3://${web_bucket_name}"
echo "  8. Delete the six out-of-band SSM parameters under ${SSM_CONFIG_PATH}/"
echo "  9. Verify nothing tagged Project=fantasy-league/Environment=${ENVIRONMENT_NAME} remains,"
echo "     and explicitly confirm the VPC$([ -n "${vpc_physical_id}" ] && echo " (${vpc_physical_id})") no longer exists"
echo "     (expected leftovers: the final snapshot; tag index lags ~minutes for CloudFront)"
echo
echo "  NOT touched: Cognito pool (imported, live), CDKToolkit bootstrap stack (runbook appendix),"
echo "  and the final snapshot$([ "${final_snapshot}" = true ] && echo " (~\$0.10/GB-mo — delete it once you are certain)")."

if [ "${execute}" != "true" ]; then
  echo
  ok "Plan only — nothing was changed. Re-run with --execute to destroy."
  exit 0
fi

# ── Confirmation gates ────────────────────────────────────────────────────────────────
if [ "${ENVIRONMENT_NAME}" = "prod" ] && [ "${ALLOW_PROD_DESTROY:-}" != "yes" ]; then
  fail "Refusing to destroy prod without ALLOW_PROD_DESTROY=yes in the environment."
fi
echo
printf 'Type the stack name (%s) to confirm PERMANENT deletion: ' "${STACK_NAME}"
read -r typed_confirmation
[ "${typed_confirmation}" = "${STACK_NAME}" ] || fail "Confirmation did not match — nothing was changed."

# ── 1. Empty the web bucket ───────────────────────────────────────────────────────────
if [ "${bucket_exists}" = "true" ]; then
  info "Emptying s3://${web_bucket_name}"
  aws s3 rm "s3://${web_bucket_name}" --recursive --only-show-errors
fi

# ── 2 + 3. Drop prod protections ──────────────────────────────────────────────────────
if [ "${ENVIRONMENT_NAME}" = "prod" ] && [ "${stack_exists}" = "true" ]; then
  info "Disabling stack termination protection"
  aws cloudformation update-termination-protection --stack-name "${STACK_NAME}" \
    --no-enable-termination-protection >/dev/null
fi
if [ "${ENVIRONMENT_NAME}" = "prod" ] && [ "${database_exists}" = "true" ]; then
  info "Disabling RDS deletion protection"
  aws rds modify-db-instance --db-instance-identifier "${database_identifier}" \
    --no-deletion-protection --apply-immediately >/dev/null
fi

# ── 4. Delete the database FIRST (prod only — non-prod is RemovalPolicy.DESTROY and the
#      stack delete below removes it directly) ─────────────────────────────────────────
# Must run before the stack delete: while the instance is alive, its ENI keeps the DB
# security group, parameter group, and one VPC subnet in use, which fails their deletion
# partway through the stack teardown (DELETE_FAILED) instead of before it starts.
if [ "${ENVIRONMENT_NAME}" = "prod" ] && [ "${database_exists}" = "true" ]; then
  if [ "${final_snapshot}" = "true" ]; then
    info "Deleting database ${database_identifier} with final snapshot ${final_snapshot_identifier}"
    aws rds delete-db-instance --db-instance-identifier "${database_identifier}" \
      --final-db-snapshot-identifier "${final_snapshot_identifier}" >/dev/null
  else
    info "Deleting database ${database_identifier} WITHOUT a final snapshot"
    aws rds delete-db-instance --db-instance-identifier "${database_identifier}" \
      --skip-final-snapshot >/dev/null
  fi
  info "Waiting for the database to finish deleting (~10 min)…"
  aws rds wait db-instance-deleted --db-instance-identifier "${database_identifier}"
  ok "Database deleted"
fi

# ── 5. Delete the stack ───────────────────────────────────────────────────────────────
if [ "${stack_exists}" = "true" ]; then
  info "Deleting stack ${STACK_NAME} (CloudFront teardown makes this slow — 10–20 min)"
  if [ "${destroy_via}" = "cdk" ]; then
    (cd "${INFRA_DIR}" && npx cdk destroy "${CDK_STACK_CONSTRUCT_ID}" -c "env=${ENVIRONMENT_NAME}" --force)
  else
    aws cloudformation delete-stack --stack-name "${STACK_NAME}"
    aws cloudformation wait stack-delete-complete --stack-name "${STACK_NAME}"
  fi
  ok "Stack deleted"
fi

# ── 6. Delete the orphaned DB subnet group ────────────────────────────────────────────
# It inherits the RETAIN policy applied to the database instance regardless of step 4's
# ordering, so it's always DELETE_SKIPPED by the stack delete and always needs this.
# Harmless to leave (RDS subnet groups don't bill), but it clutters the account forever.
if [ -n "${db_subnet_group_physical_id}" ] && \
   aws rds describe-db-subnet-groups --db-subnet-group-name "${db_subnet_group_physical_id}" >/dev/null 2>&1; then
  info "Deleting orphaned DB subnet group ${db_subnet_group_physical_id}"
  aws rds delete-db-subnet-group --db-subnet-group-name "${db_subnet_group_physical_id}"
  ok "DB subnet group deleted"
fi

# ── 7. Delete the retained (now empty) bucket ─────────────────────────────────────────
if aws s3api head-bucket --bucket "${web_bucket_name}" >/dev/null 2>&1; then
  info "Deleting bucket ${web_bucket_name}"
  aws s3 rb "s3://${web_bucket_name}"
  ok "Bucket deleted"
fi

# ── 8. Delete the out-of-band SSM parameters ──────────────────────────────────────────
full_parameter_names=()
for parameter_name in "${ssm_parameter_names[@]}"; do
  full_parameter_names+=("${SSM_CONFIG_PATH}/${parameter_name}")
done
info "Deleting SSM parameters under ${SSM_CONFIG_PATH}/"
aws ssm delete-parameters --names "${full_parameter_names[@]}" \
  --query "DeletedParameters" --output text || true
rm -f "${INFRA_DIR}/cdk-outputs.json"

# ── 9. Verify nothing is left ─────────────────────────────────────────────────────────
if [ -n "${vpc_physical_id}" ]; then
  if aws ec2 describe-vpcs --vpc-ids "${vpc_physical_id}" >/dev/null 2>&1; then
    fail "VPC ${vpc_physical_id} still exists — stack delete did not fully remove it, check the AWS console."
  fi
  ok "VPC ${vpc_physical_id} confirmed removed"
fi

info "Remaining resources tagged Project=fantasy-league, Environment=${ENVIRONMENT_NAME}:"
aws resourcegroupstaggingapi get-resources \
  --tag-filters "Key=Project,Values=fantasy-league" "Key=Environment,Values=${ENVIRONMENT_NAME}" \
  --query "ResourceTagMappingList[].ResourceARN" --output text | tr '\t' '\n' | sed 's/^/  /' || true
echo "  (expected: the final snapshot if taken; the tag index can lag a few minutes for CloudFront)"

ok "Teardown of '${ENVIRONMENT_NAME}' complete."
