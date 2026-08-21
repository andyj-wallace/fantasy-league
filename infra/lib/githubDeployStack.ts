import { Duration, Stack, StackProps, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";

const GITHUB_REPO = "andyj-wallace/fantasy-league";
const DEPLOYMENT_ACCOUNT = "345482189946";
const DEPLOYMENT_REGION = "us-east-1";
// CDK's fixed default bootstrap qualifier (matches BOOTSTRAP_ASSETS_BUCKET in scripts/deployment-env.sh).
const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";

/**
 * GitHub Actions OIDC trust for this account, plus the prod deploy role CI assumes.
 *
 * Deliberately its own stack, not part of FantasyLeagueStack: an IAM OIDC provider for
 * a given issuer URL is an account-wide singleton — CloudFormation errors if two
 * stacks each try to create one for token.actions.githubusercontent.com. Since
 * fantasy-league-dev/-staging/-prod are separate stacks, the provider has to live
 * somewhere that is itself a singleton per account. This also means CI's ability to
 * deploy/redeploy an environment survives that environment's own `cdk destroy` —
 * relevant since prod has already been torn down and rebuilt once (2026-07-13).
 *
 * Deployed manually and separately from the per-environment app stack:
 * `cd infra && npx cdk deploy FantasyLeagueGitHubDeploy` — never through
 * deploy-everything.sh (see DEPLOYMENT_RUNBOOK.md's release-process section).
 */
export class GitHubDeployStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const githubOidcProvider = new iam.OpenIdConnectProvider(this, "GitHubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
      // No `thumbprints` prop: CDK manages GitHub's thumbprint automatically via a
      // Lambda-backed custom resource in this version of aws-cdk-lib.
    });

    // Deploy only ever triggers from the `release` branch (see .github/workflows/deploy.yml
    // and DEPLOYMENT_RUNBOOK.md's release-process section) — main only runs CI, never deploys.
    // The deploy job sets `environment: production`, which changes the OIDC token's `sub`
    // claim to the `repo:OWNER/REPO:environment:NAME` form instead of the branch-ref form —
    // trust on the environment, not the ref, or every AssumeRoleWithWebIdentity call 403s.
    const prodDeployRole = new iam.Role(this, "ProdDeployRole", {
      roleName: "fantasy-league-prod-deploy-role", // matches DEPLOYMENT_PLAN.md's naming table
      description: "Assumed by GitHub Actions (OIDC) to deploy fantasy-league-prod from the release branch",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:environment:production`,
        },
      }),
    });

    // ── CDK bootstrap role assumption ──────────────────────────────────────────────
    // CDK's modern ("new-style") bootstrap model means the deploy identity mostly needs
    // sts:AssumeRole on the bootstrap-created roles, not raw CloudFormation/S3 permissions
    // directly — the deploy-role (assumed here) already carries the CloudFormation
    // permissions + iam:PassRole onto the cfn-exec-role, which is what actually
    // creates/updates resources.
    // ⚠ Verify this exact set of bootstrap role names against
    // https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html at deploy time —
    // bootstrap template versions have occasionally added/renamed roles.
    const bootstrapRoleArns = [
      `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-deploy-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
      `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-file-publishing-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
      `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-lookup-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
      // Not currently exercised (no container image assets in this app), included so a
      // future Docker-based Lambda/asset doesn't need a follow-up IAM change:
      `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-image-publishing-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
    ];
    // Deliberately NOT included: cdk-<qualifier>-cfn-exec-role-*. That role is PASSED to
    // CloudFormation by the deploy-role (iam:PassRole, already granted by the bootstrap
    // stack's own policy) — it is never assumed directly by this role.
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoleArns,
      }),
    );

    // ── Permissions the deploy *scripts* need directly (outside the cdk CLI) ───────
    // run-database-migrations.sh / publish-frontend.sh / deployment-smoke-test.sh all
    // call plain `aws` commands as this role's own identity, not via the assumed
    // bootstrap role — each needs its own grant here.
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadStackOutputsAndAccountChecks",
        actions: ["cloudformation:DescribeStacks", "lambda:GetAccountSettings"],
        // DescribeStacks resource-level scoping is unreliable across CFN API versions;
        // GetAccountSettings has no resource-level scoping at all.
        resources: ["*"],
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PreMigrationSnapshot",
        actions: ["rds:CreateDBSnapshot", "rds:DescribeDBSnapshots"],
        resources: [
          `arn:aws:rds:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:db:fantasy-league-prod-db`,
          `arn:aws:rds:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:snapshot:fantasy-league-prod-pre-migrate-*`,
        ],
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeMigrationLambda",
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:aws:lambda:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:function:fantasy-league-prod-migrate`],
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PublishFrontend",
        actions: ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
        resources: [
          `arn:aws:s3:::fantasy-league-prod-web-${DEPLOYMENT_ACCOUNT}`,
          `arn:aws:s3:::fantasy-league-prod-web-${DEPLOYMENT_ACCOUNT}/*`,
        ],
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvalidateCloudFront",
        actions: ["cloudfront:CreateInvalidation"],
        // CreateInvalidation doesn't support resource-level scoping to a specific distribution.
        resources: ["*"],
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadCognitoIdsForFrontendBuild",
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:parameter/fantasy-league/prod/cognito-user-pool-id`,
          `arn:aws:ssm:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:parameter/fantasy-league/prod/cognito-app-client-id`,
        ],
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        // Documented AWS pattern for SSM SecureString decrypt via a service condition,
        // rather than referencing the AWS-managed alias/aws/ssm key ARN directly (which
        // has historically been finicky to reference correctly from an identity policy).
        sid: "DecryptSsmSecureStrings",
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${DEPLOYMENT_REGION}.amazonaws.com` } },
      }),
    );
    prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SmokeTestChecks",
        actions: ["rds:DescribeDBInstances", "events:DescribeRule"],
        resources: [
          `arn:aws:rds:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:db:fantasy-league-prod-db`,
          `arn:aws:events:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:rule/fantasy-league-prod-match-poll`,
        ],
      }),
    );
  }
}
