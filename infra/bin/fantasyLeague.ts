#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { FantasyLeagueStack } from "../lib/fantasyLeagueStack";

/** us-east-1 is locked in: the live Cognito user pool (us-east-1_DBETCnAJP) lives there. */
const DEPLOYMENT_ACCOUNT = "345482189946";
const DEPLOYMENT_REGION = "us-east-1";

const app = new App();

const environmentName: string = app.node.tryGetContext("env") ?? "prod";
if (!["dev", "staging", "prod"].includes(environmentName)) {
  throw new Error(`Unknown environment "${environmentName}" — expected dev, staging, or prod.`);
}

new FantasyLeagueStack(app, `FantasyLeague-${environmentName[0].toUpperCase()}${environmentName.slice(1)}`, {
  stackName: `fantasy-league-${environmentName}`,
  environmentName,
  enableReservedLambdaConcurrency: app.node.tryGetContext("reservedConcurrency") === "true",
  enableMatchPollSchedule: app.node.tryGetContext("matchPollEnabled") === "true",
  terminationProtection: environmentName === "prod",
  env: { account: DEPLOYMENT_ACCOUNT, region: DEPLOYMENT_REGION },
});

Tags.of(app).add("Project", "fantasy-league");
Tags.of(app).add("Environment", environmentName);
Tags.of(app).add("ManagedBy", "cdk");
