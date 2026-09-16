import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { stageConfig } from "../config/stages.ts";
import { CiAccessStack } from "../stacks/ci-access.ts";

const app = new App();
const config = stageConfig(app.node.tryGetContext("stage"));
// Without credentials CDK_DEFAULT_ACCOUNT is unset and the stacks synthesise account-agnostic.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = { region: config.homeRegion, ...(account ? { account } : {}) };

new CiAccessStack(app, `galena-${config.stage}-ci-access`, { env, config });

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
