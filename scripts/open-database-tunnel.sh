#!/usr/bin/env bash
# Opens the sanctioned admin path to the private RDS instance: an SSM Session Manager
# port-forward through the NAT instance (no bastion, no public DB, IAM is the credential).
# Keeps running until Ctrl-C; connect from another terminal.
#
# THE TLS LESSON (first deploy): connections through the tunnel MUST append
# `?sslmode=require` to DATABASE_URL. RDS enforces TLS, but the client sees hostname
# "localhost" (which normally means local docker → no TLS), and full certificate
# verification can't ever pass here because the server cert names the RDS host,
# not localhost. sslmode=require = encrypt but don't verify — safe, because the SSM
# tunnel already authenticates both endpoints.
#
# Usage: scripts/open-database-tunnel.sh [local-port]     (default 15432; npm run db:tunnel)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"
require_correct_aws_account

local_port="${1:-15432}"

# The plugin is the AWS CLI's session transport; offer the no-sudo install if missing.
if ! command -v session-manager-plugin >/dev/null 2>&1; then
  warn "session-manager-plugin is not installed (needed for SSM sessions)."
  printf 'Install it to ~/.local/bin now (no sudo needed)? [y/N] '
  read -r answer
  [ "${answer}" = "y" ] || [ "${answer}" = "Y" ] \
    || fail "Install manually instead: brew install --cask session-manager-plugin"
  machine_arch="$(uname -m)"
  bundle_path="mac"; [ "${machine_arch}" = "arm64" ] && bundle_path="mac_arm64"
  download_dir="$(mktemp -d)"
  curl -sf "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${bundle_path}/sessionmanager-bundle.zip" \
    -o "${download_dir}/bundle.zip"
  unzip -oq "${download_dir}/bundle.zip" -d "${download_dir}"
  mkdir -p "${HOME}/.local/bin"
  cp "${download_dir}/sessionmanager-bundle/bin/session-manager-plugin" "${HOME}/.local/bin/"
  ok "Installed: $(session-manager-plugin --version)"
fi

nat_autoscaling_group_name="$(get_stack_output NatAutoScalingGroupName)"
database_endpoint="$(get_stack_output DatabaseEndpoint)"
[ -n "${nat_autoscaling_group_name}" ] && [ -n "${database_endpoint}" ] \
  || fail "Could not resolve stack outputs from ${STACK_NAME}."

# The NAT instance is ASG-managed, so its id changes on replacement — always re-discover.
nat_instance_id="$(aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=${nat_autoscaling_group_name}" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" --output text)"
[ -n "${nat_instance_id}" ] || fail "No running NAT instance found in ASG ${nat_autoscaling_group_name}."

echo
ok  "Tunnel target: ${database_endpoint}:5432 via ${nat_instance_id} → localhost:${local_port}"
info "In ANOTHER terminal, connect with (note the mandatory ?sslmode=require):"
echo
echo "  DATABASE_URL=\"postgres://fantasy_admin:\$(aws ssm get-parameter --region ${DEPLOYMENT_REGION} \\"
echo "      --name ${SSM_CONFIG_PATH}/db-password --with-decryption \\"
echo "      --query Parameter.Value --output text)@localhost:${local_port}/fantasy_league?sslmode=require\" \\"
echo "      npm run seed:mock   # or psql \"\$DATABASE_URL\", etc."
echo
info "Ctrl-C here closes the tunnel."

exec aws ssm start-session --target "${nat_instance_id}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host="${database_endpoint}",portNumber="5432",localPortNumber="${local_port}"
