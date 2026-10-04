import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { stageConfig } from "../config/stages.ts";
import { ApiStack } from "../stacks/api.ts";
import { CiAccessStack } from "../stacks/ci-access.ts";
import { DetectionStack } from "../stacks/detection.ts";
import { EmailStack } from "../stacks/email.ts";
import { FoundationStack } from "../stacks/foundation.ts";
import { ProbeStack } from "../stacks/probe.ts";
import { SmokeStack } from "../stacks/smoke.ts";
import { CertificateStack, PageReplicaStack, StatusPageStack } from "../stacks/status-page.ts";
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
// Only dev runs the deployed smoke test.
if (config.stage === "dev") new SmokeStack(app, `galena-${config.stage}-smoke`, { env, config });
const api = new ApiStack(app, `galena-${config.stage}-api`, { env, config });
const webCertificate = config.webDomain
  ? new CertificateStack(app, `galena-${config.stage}-web-certificate`, {
      env: inRegion("us-east-1"),
      domain: config.webDomain,
      crossRegionReferences: true,
    }).certificate
  : undefined;
new WebStack(app, `galena-${config.stage}-web`, {
  env,
  config,
  api: api.api,
  domain: config.webDomain,
  ...(webCertificate ? { certificate: webCertificate, crossRegionReferences: true } : {}),
});
new WorkerAccessStack(app, `galena-${config.stage}-worker-access`, { env, config });
if (config.email) {
  new EmailStack(app, `galena-${config.stage}-email`, {
    env,
    config: { ...config, email: config.email },
  });
}
// The status page shares nothing with the stacks above, so it serves while they are down.
const replica = new PageReplicaStack(app, `galena-${config.stage}-page-replica`, {
  env: inRegion(config.pageRegions.replica),
  config,
});
const certificate = config.pageDomain
  ? new CertificateStack(app, `galena-${config.stage}-page-certificate`, {
      env: inRegion("us-east-1"),
      domain: config.pageDomain,
      crossRegionReferences: true,
    }).certificate
  : undefined;
new StatusPageStack(app, `galena-${config.stage}-page`, {
  env: inRegion(config.pageRegions.primary),
  config,
  apiEndpoint: api.api.apiEndpoint,
  ...(certificate ? { certificate } : {}),
  crossRegionReferences: true,
}).addStackDependency(replica);

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
