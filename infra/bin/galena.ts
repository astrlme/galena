import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { checkRepository, loadConfig } from "../config/stages.ts";
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

// Add or remove a stack here and in `expectedStacks` (config/stages.ts), which `galena doctor`
// checks a deployment against.
const app = new App();
// `-c config=<path>` (relative to where cdk runs), else galena.config.json at the repository root.
const config = loadConfig(
  resolve(
    app.node.tryGetContext("config") ??
      fileURLToPath(new URL("../../galena.config.json", import.meta.url)),
  ),
);
checkRepository(config, process.env);
// Without credentials CDK_DEFAULT_ACCOUNT is unset and the stacks synthesise account-agnostic.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const inRegion = (region: string) => ({ region, ...(account ? { account } : {}) });
const env = inRegion(config.homeRegion);

// Only a deployment that deploys from GitHub Actions needs the OIDC deploy role.
if (config.github) {
  new CiAccessStack(app, `galena-${config.stage}-ci-access`, {
    env,
    config: { ...config, github: config.github },
  });
}
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
if (config.smoke && config.github) {
  new SmokeStack(app, `galena-${config.stage}-smoke`, {
    env,
    config: { ...config, github: config.github },
  });
}
const api = new ApiStack(app, `galena-${config.stage}-api`, { env, config });
const webCertificate = config.webDomain
  ? new CertificateStack(app, `galena-${config.stage}-dashboard-certificate`, {
      env: inRegion("us-east-1"),
      domain: config.webDomain,
      crossRegionReferences: true,
    }).certificate
  : undefined;
const web = new WebStack(app, `galena-${config.stage}-web`, {
  env,
  config,
  api: api.api,
  domain: config.webDomain,
  ...(webCertificate ? { certificate: webCertificate, crossRegionReferences: true } : {}),
});
if (config.siteDomain) {
  const { certificate } = new CertificateStack(app, `galena-${config.stage}-site-certificate`, {
    env: inRegion("us-east-1"),
    domain: config.siteDomain,
    crossRegionReferences: true,
  });
  // After the dashboard, so CloudFront has released the name when it moves from there.
  new WebStack(app, `galena-${config.stage}-site`, {
    env,
    config,
    domain: config.siteDomain,
    certificate,
    crossRegionReferences: true,
    siteDir: fileURLToPath(new URL("../../apps/web/out-site", import.meta.url)),
  }).addStackDependency(web);
}
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
