import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
  Tags,
  aws_apigatewayv2 as apigatewayv2,
  aws_apigatewayv2_integrations as apigatewayv2Integrations,
  aws_budgets as budgets,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as cloudfrontOrigins,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as eventsTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_rds as rds,
  aws_resourcegroups as resourcegroups,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as snsSubscriptions,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { FckNatInstanceProvider } from "cdk-fck-nat";
import { Construct } from "constructs";

export interface FantasyLeagueStackProps extends StackProps {
  /** dev | staging | prod — the only thing that differs between environments. */
  environmentName: string;
  /** Reserved concurrency needs the account Lambda limit to exceed the reservation by ≥100.
   * This account currently has the new-account limit of 10, so reservations are off until a
   * Service Quotas increase lands (deploy with `-c reservedConcurrency=true` after). The
   * match-poll worker stays overlap-safe regardless via the DB-persisted nextLivePollDueAt gate. */
  enableReservedLambdaConcurrency: boolean;
  /** The free API-Football plan cannot serve current-season data (remaining-gaps-todo.md item 6),
   * so every poll cycle fails at its first provider call — the schedule is disabled until the
   * data-plan decision lands. Re-enable with `-c matchPollEnabled=true` and a deploy. */
  enableMatchPollSchedule: boolean;
  /** CloudFront's pricing-plan subscription auto-creates and attaches a WebACL when a
   * distribution is first created, and then refuses to let CloudFormation remove it
   * ("Distributions with a pricing plan subscription must have a web ACL resource"). CDK has no
   * way to discover that ARN, so `deploy-infrastructure.sh` reads it off the live distribution
   * and passes it back in. Undefined on a first deploy — there is no distribution yet, and
   * CloudFront creates the WebACL itself. Do not hardcode: the ARN differs per environment. */
  existingWebAclArn?: string;
}

const BUDGET_ALERT_EMAIL = "andy.illegalized@gmail.com";
const FOOTBALL_DATA_API_BASE_URL = "https://v3.football.api-sports.io";
const RDS_MASTER_USERNAME = "fantasy_admin";
const APP_DATABASE_ROLE_NAME = "fantasy_app";
const DATABASE_NAME = "fantasy_league";

/** The application repo root — Lambda entry points and the deps lockfile live there, not in infra/. */
const APPLICATION_PROJECT_ROOT = path.join(__dirname, "..", "..");

/**
 * The whole production stack, per docs/deployment/DEPLOYMENT_PLAN.md: a dedicated VPC with a
 * fck-nat NAT instance, a private RDS Postgres, VPC Lambdas (API router, two scheduled workers,
 * migration), an API Gateway HTTP API, and CloudFront + private S3 for the static frontend.
 * Secrets are SSM SecureStrings under /fantasy-league/<env>/ created out-of-band — the stack
 * references them but never creates or overwrites their values.
 */
export class FantasyLeagueStack extends Stack {
  constructor(scope: Construct, id: string, props: FantasyLeagueStackProps) {
    super(scope, id, props);

    const environmentName = props.environmentName;
    const isProduction = environmentName === "prod";
    const resourceName = (suffix: string) => `fantasy-league-${environmentName}-${suffix}`;
    const ssmConfigPath = `/fantasy-league/${environmentName}`;

    // ── Networking ──────────────────────────────────────────────────────────────────────
    // Dedicated VPC (never the account default): controlled public/private split, DB
    // guaranteed private, reproducible in a fresh account. 2 AZs because an RDS subnet
    // group must span two even in single-AZ mode.
    const natInstanceProvider = new FckNatInstanceProvider({
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      // enableSsm defaults to true → Session Manager is the (only) admin path to the VPC:
      // no key pair, no bastion, no inbound ports.
    });

    const vpc = new ec2.Vpc(this, "FantasyLeagueVpc", {
      vpcName: resourceName("vpc"),
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: natInstanceProvider,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    Tags.of(vpc).add("Component", "network");

    // The NAT instance forwards for the private subnets, so it must accept their traffic.
    natInstanceProvider.securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      "Outbound internet traffic from the private subnets",
    );

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      securityGroupName: resourceName("lambda-sg"),
      vpc,
      description: "All fantasy-league Lambdas; egress to the database and (via NAT) the internet",
      allowAllOutbound: true,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      securityGroupName: resourceName("db-sg"),
      vpc,
      description: "RDS Postgres; ingress on 5432 from the Lambda SG and the NAT admin path only",
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      "API and worker Lambdas",
    );
    // Deliberate, documented exception to "Lambda SG only": SSM Session Manager port-forwarding
    // terminates on the NAT instance, which is the sanctioned no-bastion admin path (used for
    // seeding and ad-hoc admin). Nothing on the internet can reach either hop directly.
    databaseSecurityGroup.addIngressRule(
      natInstanceProvider.securityGroup,
      ec2.Port.tcp(5432),
      "Admin access via SSM port-forwarding through the NAT instance",
    );

    // ── Database ────────────────────────────────────────────────────────────────────────
    const databaseParameterGroup = new rds.ParameterGroup(this, "DatabaseParameterGroup", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      description: "fantasy-league Postgres parameters (TLS required)",
      parameters: { "rds.force_ssl": "1" },
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      instanceIdentifier: resourceName("db"),
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [databaseSecurityGroup],
      // The master password is created out-of-band in SSM (SecureString) and referenced here —
      // never stored in the template. The app never uses this credential; it connects as the
      // least-privilege role the migration Lambda provisions.
      credentials: rds.Credentials.fromPassword(
        RDS_MASTER_USERNAME,
        SecretValue.ssmSecure(`${ssmConfigPath}/db-password`),
      ),
      databaseName: DATABASE_NAME,
      multiAz: false,
      publiclyAccessible: false,
      storageEncrypted: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      parameterGroup: databaseParameterGroup,
      backupRetention: Duration.days(7),
      deletionProtection: isProduction,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    Tags.of(database).add("Component", "data");

    // ── CloudFront origin lock ──────────────────────────────────────────────────────────
    // The HTTP API's execute-api URL is public and can't be disabled without a custom domain,
    // so CloudFront injects this shared secret as an origin header and the API Lambda rejects
    // anything without it — making the CDN the only usable path to the API.
    //
    // Deliberately a plain String, not a SecureString like every other parameter here:
    // CloudFormation only resolves {{resolve:ssm-secure}} in an allowlist of properties that
    // excludes CloudFront origin headers. That costs nothing, because the value is readable via
    // `aws cloudfront get-distribution-config` regardless of how it's stored — it's a bypass
    // token that proves "this came through our CDN", not a credential guarding data.
    //
    // Read once and handed to both consumers below, so the two can never drift apart.
    const cloudFrontOriginVerifySecret = ssm.StringParameter.valueForStringParameter(
      this,
      `${ssmConfigPath}/cloudfront-origin-secret`,
    );

    // ── Lambdas ─────────────────────────────────────────────────────────────────────────
    const commonLambdaEnvironment = {
      SSM_CONFIG_PATH: ssmConfigPath,
      DB_HOST: database.dbInstanceEndpointAddress,
      DB_PORT: database.dbInstanceEndpointPort,
      DB_NAME: DATABASE_NAME,
    };

    const buildNodejsFunction = (options: {
      constructId: string;
      functionNameSuffix: string;
      entry: string;
      environment: Record<string, string>;
      timeout: Duration;
      reservedConcurrentExecutions?: number;
      bundleMigrations?: boolean;
      component: string;
    }): lambdaNodejs.NodejsFunction => {
      const functionName = resourceName(options.functionNameSuffix);
      const logGroup = new logs.LogGroup(this, `${options.constructId}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      const lambdaFunction = new lambdaNodejs.NodejsFunction(this, options.constructId, {
        functionName,
        entry: path.join(APPLICATION_PROJECT_ROOT, options.entry),
        depsLockFilePath: path.join(APPLICATION_PROJECT_ROOT, "package-lock.json"),
        projectRoot: APPLICATION_PROJECT_ROOT,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: options.timeout,
        reservedConcurrentExecutions: props.enableReservedLambdaConcurrency
          ? options.reservedConcurrentExecutions
          : undefined,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [lambdaSecurityGroup],
        environment: options.environment,
        logGroup,
        bundling: {
          target: "node22",
          // The Node 22 runtime ships AWS SDK v3; pg-native is pg's optional native binding,
          // guarded by try/require and never installed here.
          externalModules: ["@aws-sdk/*", "pg-native"],
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (inputDir: string, outputDir: string) => [
              // The db client reads the RDS CA bundle from beside its own file at runtime.
              `cp ${inputDir}/src/db/rds-us-east-1-ca-bundle.pem ${outputDir}/`,
              ...(options.bundleMigrations
                ? [`cp -R ${inputDir}/src/db/migrations ${outputDir}/migrations`]
                : []),
            ],
          },
        },
      });

      // Every Lambda reads its secrets from the environment's SSM path at cold start.
      lambdaFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmConfigPath}`,
            `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmConfigPath}/*`,
          ],
        }),
      );

      Tags.of(lambdaFunction).add("Component", options.component);
      return lambdaFunction;
    };

    const apiLambda = buildNodejsFunction({
      constructId: "ApiLambda",
      functionNameSuffix: "api",
      entry: "src/api/lambdaHandler.ts",
      environment: {
        ...commonLambdaEnvironment,
        DB_USER: APP_DATABASE_ROLE_NAME,
        DB_PASSWORD_PARAMETER: "db-app-password",
        AUTH_PROVIDER: "cognito",
        // Only this Lambda serves HTTP, so only this one enforces the origin lock.
        CLOUDFRONT_ORIGIN_VERIFY_SECRET: cloudFrontOriginVerifySecret,
      },
      timeout: Duration.seconds(29),
      component: "api",
    });

    const matchPollWorkerLambda = buildNodejsFunction({
      constructId: "MatchPollWorkerLambda",
      functionNameSuffix: "worker",
      entry: "src/workers/handler.ts",
      environment: {
        ...commonLambdaEnvironment,
        DB_USER: APP_DATABASE_ROLE_NAME,
        DB_PASSWORD_PARAMETER: "db-app-password",
        FOOTBALL_DATA_API_BASE_URL,
      },
      // Sized to the worst-case provider-paced cycle (~5 min), not the typical one; safe to
      // exceed the 1-minute schedule because reserved concurrency 1 skips overlapping ticks
      // and the DB-persisted nextLivePollDueAt gate makes extra ticks no-op cheaply.
      timeout: Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      component: "worker",
    });

    const priceUpdateLambda = buildNodejsFunction({
      constructId: "PriceUpdateLambda",
      functionNameSuffix: "price-update",
      entry: "src/workers/monthlyPriceUpdateHandler.ts",
      environment: {
        ...commonLambdaEnvironment,
        DB_USER: APP_DATABASE_ROLE_NAME,
        DB_PASSWORD_PARAMETER: "db-app-password",
        FOOTBALL_DATA_API_BASE_URL,
      },
      timeout: Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      component: "worker",
    });

    const migrationLambda = buildNodejsFunction({
      constructId: "MigrationLambda",
      functionNameSuffix: "migrate",
      entry: "src/db/migrateLambda.ts",
      environment: {
        ...commonLambdaEnvironment,
        // Migrations run as the master role; it also provisions the app role from db-app-password.
        DB_USER: RDS_MASTER_USERNAME,
        DB_PASSWORD_PARAMETER: "db-password",
      },
      timeout: Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      bundleMigrations: true,
      component: "data",
    });

    // ── Worker schedules ────────────────────────────────────────────────────────────────
    // retryAttempts 0 on both schedules: a failed scheduled run's natural retry is the next
    // tick — async-Lambda's default double retry only triples provider calls and error logs.
    //
    // The match-poll target gets an SQS dead-letter queue: since retryAttempts is 0,
    // EventBridge sends the triggering event here on the very first failure, not after N
    // retries. That's deliberate — it becomes both the "a tick failed" alarm signal (see the
    // Alerting section below) and the audit trail (the event body is preserved for inspection).
    const matchPollWorkerDeadLetterQueue = new sqs.Queue(this, "MatchPollWorkerDeadLetterQueue", {
      queueName: resourceName("worker-dlq"),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    Tags.of(matchPollWorkerDeadLetterQueue).add("Component", "worker");

    const matchPollRule = new events.Rule(this, "MatchPollRule", {
      ruleName: resourceName("match-poll"),
      description: "Ticks the match-poll worker; the worker itself decides (via DB state) whether a provider poll is due",
      schedule: events.Schedule.rate(Duration.minutes(1)),
      enabled: props.enableMatchPollSchedule,
      targets: [
        new eventsTargets.LambdaFunction(matchPollWorkerLambda, {
          retryAttempts: 0,
          deadLetterQueue: matchPollWorkerDeadLetterQueue,
        }),
      ],
    });
    Tags.of(matchPollRule).add("Component", "worker");

    const priceUpdateRule = new events.Rule(this, "PriceUpdateRule", {
      ruleName: resourceName("price-update"),
      description: "Monthly player price update (PRICE_UPDATE_DAY)",
      schedule: events.Schedule.cron({ minute: "0", hour: "6", day: "1", month: "*", year: "*" }),
      targets: [new eventsTargets.LambdaFunction(priceUpdateLambda, { retryAttempts: 0 })],
    });
    Tags.of(priceUpdateRule).add("Component", "worker");

    // ── HTTP API ────────────────────────────────────────────────────────────────────────
    const httpApi = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: resourceName("http-api"),
      description: "Routes every request to the single fantasy-league router Lambda",
    });
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration("ApiLambdaIntegration", apiLambda, {
        // 1.0 keeps the event shape identical to the APIGatewayProxyEvent the handlers were built on.
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_1_0,
      }),
    });
    Tags.of(httpApi).add("Component", "api");

    // Without this the API inherits the account default (~10,000 rps). Every request is a Lambda
    // invocation plus an RDS connection and the /api/* behavior is CACHING_DISABLED, so nothing
    // else bounds the cost of an abusive client. 50 rps sustained is far above what a league of
    // this size generates, while still capping runaway traffic; over it, API Gateway returns 429.
    //
    // Set on the L1 stage because HttpStageProps inherits `throttle` from StageOptions but
    // HttpApiProps does not expose it, and HttpApi builds the $default stage itself. Opting out
    // with createDefaultStage:false and an explicit HttpStage would replace the deployed stage.
    const httpApiDefaultStage = httpApi.defaultStage?.node.defaultChild as
      | apigatewayv2.CfnStage
      | undefined;
    if (httpApiDefaultStage !== undefined) {
      httpApiDefaultStage.defaultRouteSettings = {
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      };
    }

    // ── Frontend: private S3 + CloudFront ───────────────────────────────────────────────
    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: resourceName(`web-${this.account}`),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(webBucket).add("Component", "web");

    const urlRewriteFunction = new cloudfront.Function(this, "UrlRewriteFunction", {
      functionName: resourceName("url-rewrite"),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: path.join(__dirname, "urlRewriteFunction.js") }),
      comment: "Rewrites extensionless page URLs to the static export's flat .html files",
    });

    // apiEndpoint is "https://<id>.execute-api.<region>.amazonaws.com" — origins want the bare domain.
    const httpApiDomainName = Fn.select(2, Fn.split("/", httpApi.apiEndpoint));

    const distribution = new cloudfront.Distribution(this, "WebDistribution", {
      comment: resourceName("cdn"),
      defaultRootObject: "index.html",
      // No priceClass, deliberately. CloudFront put this distribution on its Free pricing plan at
      // creation, which forbids the property outright ("Distributions with the Free pricing plan
      // can't have the following features: Price class") and pins every distribution to
      // PriceClass_All. The stack asked for PRICE_CLASS_100 from day one and CloudFront silently
      // ignored it — the live distribution has always been PriceClass_All — so removing this
      // changes nothing in reality; it only lets the stack update again. Revisit if the
      // distribution is ever moved off the Free plan.
      //
      // Re-declares the WebACL CloudFront attached on creation, so CloudFormation doesn't try to
      // strip it on update (see existingWebAclArn). Its managed rule groups — CommonRuleSet,
      // KnownBadInputsRuleSet, AmazonIpReputationList — are CloudFront's defaults, not ours.
      webAclId: props.existingWebAclArn,
      defaultBehavior: {
        // LIST access makes S3 answer missing keys with a plain 404 instead of 403; there are
        // deliberately no distribution-wide custom error pages because they would also rewrite
        // API error responses (same distribution serves /api/*).
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(webBucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: urlRewriteFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // Same-origin API: the browser calls /api/* on the site's own domain, so no CORS.
        "/api/*": {
          // The origin lock (see the CloudFront origin lock section above). CloudFront overwrites
          // a same-named header sent by the viewer, so a client cannot forge or preserve its own
          // value through this behavior. Header name is mirrored in
          // src/api/verifyCloudFrontOriginSecret.ts — change both together.
          origin: new cloudfrontOrigins.HttpOrigin(httpApiDomainName, {
            customHeaders: { "x-origin-verify": cloudFrontOriginVerifySecret },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forward everything except Host — API Gateway must see its own hostname.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    Tags.of(distribution).add("Component", "web");

    // ── Alerting ────────────────────────────────────────────────────────────────────────
    // One SNS topic, one email subscriber — reuses the Budget's alert address so there's a
    // single "where do ops emails go" answer. Every alarm below fans into this topic; add more
    // subscribers here (e.g. a Slack webhook via AWS Chatbot) without touching any alarm.
    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: resourceName("alerts"),
      displayName: "fantasy-league alerts",
    });
    alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(BUDGET_ALERT_EMAIL));
    Tags.of(alertTopic).add("Component", "ops");

    const alarmAction = new cloudwatchActions.SnsAction(alertTopic);
    const addAlarm = (constructId: string, alarmProps: cloudwatch.AlarmProps): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, constructId, alarmProps);
      alarm.addAlarmAction(alarmAction);
      Tags.of(alarm).add("Component", "ops");
      return alarm;
    };

    // RDS — CPU, storage, connections ----------------------------------------------------
    addAlarm("DatabaseCpuHighAlarm", {
      alarmName: resourceName("db-cpu-high"),
      alarmDescription: "db.t4g.micro sustained high CPU — slow query, runaway worker cycle, or undersized instance",
      metric: database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    addAlarm("DatabaseFreeStorageLowAlarm", {
      alarmName: resourceName("db-free-storage-low"),
      alarmDescription: "Free storage below ~2 GiB — the 20 GB baseline allocation autoscales to 50 GB, but a sudden burst can outrun it",
      metric: database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      threshold: 2 * 1024 * 1024 * 1024, // 2 GiB
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // "Free connections low" ⇒ DatabaseConnections climbing toward max_connections. There is no
    // direct "free connections" CloudWatch metric; this alarms on the same DatabaseConnections
    // metric, interpreted the other way round.
    // ⚠ Verify this threshold against the parameter group's actual max_connections
    // (`aws rds describe-db-parameters --db-parameter-group-name ... --query
    // "Parameters[?ParameterName=='max_connections'].ParameterValue"`) before relying on it —
    // 40 is a placeholder sized to today's connection budget (Lambda pools cap at 1-2
    // connections/instance, account concurrency limit is 10 while reserved concurrency is off).
    addAlarm("DatabaseConnectionsHighAlarm", {
      alarmName: resourceName("db-connections-high"),
      alarmDescription: "DatabaseConnections approaching max_connections — verify the threshold against the instance's actual max_connections (see comment)",
      metric: database.metricDatabaseConnections({ period: Duration.minutes(5) }),
      threshold: 40,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // RDS "instance unhealthy" — not a CloudWatch alarm. There's no CloudWatch metric that
    // directly represents "RDS instance unhealthy/unavailable"; the AWS-native signal for that
    // is an RDS Event Subscription, a different mechanism (RDS pushes structured events to SNS
    // directly). Only the L1 CfnEventSubscription exists — no CDK L2 wrapper.
    // ⚠ Verify the exact category strings before relying on this (`aws rds
    // describe-event-categories --source-type db-instance`).
    new rds.CfnEventSubscription(this, "DatabaseEventSubscription", {
      subscriptionName: resourceName("db-events"),
      snsTopicArn: alertTopic.topicArn,
      sourceType: "db-instance",
      sourceIds: [database.instanceIdentifier],
      eventCategories: ["availability", "failure", "recovery"],
    });
    alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowRdsEventPublish",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("events.rds.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [alertTopic.topicArn],
      }),
    );

    // API Lambda — errors and throttles ----------------------------------------------------
    addAlarm("ApiLambdaErrorsAlarm", {
      alarmName: resourceName("api-errors-high"),
      alarmDescription: "API Lambda error rate — check CloudWatch Logs for fantasy-league-<env>-api",
      metric: apiLambda.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    addAlarm("ApiLambdaThrottlesAlarm", {
      alarmName: resourceName("api-throttles"),
      alarmDescription: "API Lambda invocations throttled — likely the account/reserved concurrency limit",
      metric: apiLambda.metricThrottles({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Match-poll worker — "repeated failures" via the DLQ created above --------------------
    // Any message present means at least one tick failed (retryAttempts:0 sends it straight to
    // the DLQ on first failure, not after N retries) — worth a human looking at once, since the
    // worker is otherwise meant to be self-healing via the next tick.
    addAlarm("MatchPollWorkerDlqAlarm", {
      alarmName: resourceName("worker-dlq-not-empty"),
      alarmDescription: "The match-poll worker's dead-letter queue has messages — a scheduled tick failed; inspect the queue body for the event/error",
      metric: matchPollWorkerDeadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // NAT instance — ASG "unhealthy" proxy --------------------------------------------------
    // cdk-fck-nat's ASG has group-metrics collection on by default, so GroupInServiceInstances
    // is actually published. Guard for undefined defensively, matching the existing `?? "unknown"`
    // fallback on the NatAutoScalingGroupName output below.
    const natAutoScalingGroup = natInstanceProvider.autoScalingGroups[0];
    if (natAutoScalingGroup !== undefined) {
      addAlarm("NatAsgUnhealthyAlarm", {
        alarmName: resourceName("nat-asg-unhealthy"),
        alarmDescription: "NAT instance ASG has 0 in-service instances — worker/API egress is down until the ASG relaunches (~2-4 min self-heal)",
        metric: new cloudwatch.Metric({
          namespace: "AWS/AutoScaling",
          metricName: "GroupInServiceInstances",
          dimensionsMap: { AutoScalingGroupName: natAutoScalingGroup.autoScalingGroupName },
          period: Duration.minutes(5),
          statistic: "Average",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
    }

    // CloudFront — elevated 5xx -------------------------------------------------------------
    // A standard (free) CloudFront metric — no publishAdditionalMetrics flag needed on the
    // distribution. CloudFront metrics only ever publish to us-east-1, matching this stack.
    addAlarm("CloudFrontElevated5xxAlarm", {
      alarmName: resourceName("cdn-5xx-elevated"),
      alarmDescription: "CloudFront 5xx error rate elevated — could be API Gateway/Lambda/RDS or an S3-origin issue",
      metric: distribution.metric5xxErrorRate({ period: Duration.minutes(5), statistic: "Average" }),
      threshold: 5, // percent
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── Cost guardrail ──────────────────────────────────────────────────────────────────
    // Account-wide monthly cost budget (tag-scoped budgets need cost-allocation tags activated
    // in the billing console first — revisit once that one-time activation is done). Alarms on
    // absolute dollar amounts rather than a percentage of the budget limit, so the thresholds
    // read the same regardless of what budgetLimit is set to.
    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: resourceName("monthly-cost"),
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: 150, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "ABSOLUTE_VALUE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: BUDGET_ALERT_EMAIL }],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 150,
            thresholdType: "ABSOLUTE_VALUE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: BUDGET_ALERT_EMAIL }],
        },
      ],
    });

    // ── Resource Group ──────────────────────────────────────────────────────────────────
    // One console view of everything in this environment, driven by the stack-wide tags.
    // Tag-based groups are regional: they capture the VPC/RDS/Lambda/S3/API resources here in
    // us-east-1; global CloudFront resources and Budgets may not appear — that's an AWS
    // limitation of tag queries, not missing tags.
    new resourcegroups.CfnGroup(this, "ProjectResourceGroup", {
      name: resourceName("resources"),
      // Resource Group descriptions only allow [a-zA-Z0-9_.- ] — no slashes or commas.
      description: `Everything belonging to fantasy-league ${environmentName} grouped by the Project and Environment tags`,
      resourceQuery: {
        type: "TAG_FILTERS_1_0",
        query: {
          resourceTypeFilters: ["AWS::AllSupported"],
          tagFilters: [
            { key: "Project", values: ["fantasy-league"] },
            { key: "Environment", values: [environmentName] },
          ],
        },
      },
    });

    // ── Outputs ─────────────────────────────────────────────────────────────────────────
    new CfnOutput(this, "CloudFrontUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "CloudFrontDistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new CfnOutput(this, "HttpApiEndpoint", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "ApiLambdaName", { value: apiLambda.functionName });
    new CfnOutput(this, "MatchPollWorkerLambdaName", { value: matchPollWorkerLambda.functionName });
    new CfnOutput(this, "PriceUpdateLambdaName", { value: priceUpdateLambda.functionName });
    new CfnOutput(this, "MigrationLambdaName", { value: migrationLambda.functionName });
    new CfnOutput(this, "DatabaseEndpoint", { value: database.dbInstanceEndpointAddress });
    new CfnOutput(this, "NatAutoScalingGroupName", {
      value: natInstanceProvider.autoScalingGroups[0]?.autoScalingGroupName ?? "unknown",
    });
  }
}
