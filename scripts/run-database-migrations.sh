#!/usr/bin/env bash
# Applies Drizzle migrations to the deployed database by invoking the migration Lambda
# (the RDS instance is private — nothing outside the VPC can run migrations directly).
# Also (re)provisions the least-privilege fantasy_app role. Safe to run repeatedly.
#
# Takes a manual pre-migration snapshot first (RELIABILITY_PLAN.md §3: "Manual snapshot
# before every schema migration") — cheap insurance against a bad migration. See the same
# doc's expand/contract section for why the migration itself should still be additive-only
# regardless of having this safety net.
#
# Usage: scripts/run-database-migrations.sh      (or: npm run deploy:migrate)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

database_identifier="${STACK_NAME}-db"
snapshot_identifier="${STACK_NAME}-pre-migrate-$(date -u +%Y%m%d-%H%M%S)"

info "Taking pre-migration snapshot ${snapshot_identifier} of ${database_identifier}…"
aws rds create-db-snapshot \
  --db-instance-identifier "${database_identifier}" \
  --db-snapshot-identifier "${snapshot_identifier}" \
  --query "DBSnapshot.DBSnapshotIdentifier" --output text >/dev/null
info "Waiting for the snapshot to become available (a few minutes for a small DB)…"
aws rds wait db-snapshot-available --db-snapshot-identifier "${snapshot_identifier}"
ok "Snapshot ${snapshot_identifier} available."

migration_function_name="$(get_stack_output MigrationLambdaName)"
[ -n "${migration_function_name}" ] || fail "Could not resolve MigrationLambdaName from stack ${STACK_NAME}."

info "Invoking ${migration_function_name} (cold start + migrations can take ~30s)…"
response_file="$(mktemp)"
aws lambda invoke --function-name "${migration_function_name}" \
  --cli-binary-format raw-in-base64-out --cli-read-timeout 300 \
  "${response_file}" >/dev/null

cat "${response_file}"; echo
python3 - "${response_file}" <<'PYTHON'
import json, sys
payload = json.load(open(sys.argv[1]))
if payload.get("status") != "migrations-applied":
    sys.exit(f"Migration failed: {payload}")
PYTHON
ok "Migrations applied."
