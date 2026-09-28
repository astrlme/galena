import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { stageConfig } from "../config/stages.ts";
import { ApiStack } from "../stacks/api.ts";
import { CiAccessStack } from "../stacks/ci-access.ts";
import { DetectionStack } from "../stacks/detection.ts";
import { FoundationStack } from "../stacks/foundation.ts";
import { ProbeStack } from "../stacks/probe.ts";
import { WebStack } from "../stacks/web.ts";
import { WorkerAccessStack } from "../stacks/worker-access.ts";

const app = new App();
const config = stageConfig(app.node.tryGetContext("stage"));
// Without credentials CDK_DEFAULT_ACCOUNT is unset and the stacks synthesise account-agnostic.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const inRegion = (region: string) => ({ region, ...(account ? { account } : {}) });
const env = inRegion(config.homeRegion);

new CiAccessStack(app, `galena-${config.stage}-ci-access`, { env, config });
// The probe stacks take the config bucket and the queue from Foundation in another region.
const foundation = new FoundationStack(app, `galena-${config.stage}-foundation`, {
  env,
  config,
  crossRegionReferences: true,
});
for (const region of config.probeRegions) {
  new ProbeStack(app, `galena-${config.stage}-probe-${region}`, {
    env: inRegion(region),
    config,
    configBucket: foundation.config,
    queue: foundation.checkResults,
    crossRegionReferences: true,
  });
}
new DetectionStack(app, `galena-${config.stage}-detection`, { env, config });
const api = new ApiStack(app, `galena-${config.stage}-api`, { env, config });
new WebStack(app, `galena-${config.stage}-web`, { env, config, api: api.api });
new WorkerAccessStack(app, `galena-${config.stage}-worker-access`, { env, config });

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
