import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import {
  ACMClient,
  type CertificateDetail,
  DescribeCertificateCommand,
  ListCertificatesCommand,
} from "@aws-sdk/client-acm";
import { loadConfig, type StageConfig } from "@galena/infra/config";
import {
  bootstrapVersions,
  callerIdentity,
  parameterTypes,
  putSecret,
  readStacks,
  type Stack,
} from "./aws.ts";
import { describeError, nodeCheck } from "./doctor.ts";
import { prompter } from "./prompt.ts";
import { pnpm } from "./run.ts";

type Deployment = StageConfig & { triggerProjectRef: string };
type Say = (text: string) => void;

/** New values for the secrets deploy makes itself: 32 random bytes each. */
export const newSecret = {
  "auth-secret": () => randomBytes(32).toString("hex"),
  "app-key": () => randomBytes(32).toString("base64"),
  "setup-token": () => randomBytes(32).toString("hex"),
};

/** Which of its own secrets deploy still has to make; the setup token only before the first. */
export function secretsToMake(
  config: StageConfig,
  existing: Set<string>,
  firstDeploy: boolean,
): (keyof typeof newSecret)[] {
  const names: (keyof typeof newSecret)[] = ["auth-secret", "app-key"];
  if (firstDeploy) names.push("setup-token");
  return names.filter((name) => !existing.has(`/galena/${config.stage}/${name}`));
}

async function bootstrap(config: Deployment, account: string, configPath: string, say: Say) {
  const missing = [...(await bootstrapVersions(config))].flatMap(([region, version]) =>
    version ? [] : [region],
  );
  if (!missing.length) return say("CDK is bootstrapped in every region.");
  say(`Bootstrapping CDK in ${missing.join(", ")}.`);
  await pnpm([
    "--filter",
    "@galena/infra",
    "exec",
    "cdk",
    "bootstrap",
    ...missing.map((region) => `aws://${account}/${region}`),
    "-c",
    `config=${configPath}`,
  ]);
}

async function createSecrets(
  config: Deployment,
  stacks: Map<string, Stack>,
  say: Say,
  askHidden: ReturnType<typeof prompter>["askHidden"],
) {
  const existing = new Set((await parameterTypes(config)).keys());
  const firstDeploy = stacks.get(`galena-${config.stage}-api`)?.status === undefined;
  const made = secretsToMake(config, existing, firstDeploy);
  for (const name of made) await putSecret(config, name, newSecret[name]());
  const stored: string[] = [...made];
  if (!existing.has(`/galena/${config.stage}/trigger-secret-key`)) {
    const key = await askHidden(
      "trigger.dev production secret key (tr_prod_…, from the project's API keys)",
      (answer) =>
        answer.startsWith("tr_prod_")
          ? undefined
          : "That isn't a production key; it starts tr_prod_.",
    );
    await putSecret(config, "trigger-secret-key", key);
    stored.push("trigger-secret-key");
  }
  say(
    stored.length
      ? `Stored ${stored.join(", ")} as SecureStrings under /galena/${config.stage}/.`
      : "Every secret is already stored.",
  );
}

/** The config's own domains, which get certificates in us-east-1. */
const domainsOf = (config: StageConfig) =>
  [config.pageDomain, config.webDomain, config.siteDomain].filter((d): d is string => !!d);

/** The CNAMEs that validate pending certificates for `domains`, once ACM has made them. */
export function validationRecords(
  domains: string[],
  certificates: (CertificateDetail | undefined)[],
): { domain: string; name: string; value: string }[] {
  return certificates.flatMap((certificate) =>
    (certificate?.DomainValidationOptions ?? []).flatMap(({ DomainName, ResourceRecord }) =>
      DomainName && domains.includes(DomainName) && ResourceRecord?.Name && ResourceRecord.Value
        ? [{ domain: DomainName, name: ResourceRecord.Name, value: ResourceRecord.Value }]
        : [],
    ),
  );
}

/**
 * While CDK runs, prints each validation record once: CloudFormation waits until the record
 * exists at the DNS host, and ACM only names it after the certificate is created.
 */
async function watchCertificates(config: StageConfig, say: Say, signal: AbortSignal) {
  const domains = domainsOf(config);
  if (!domains.length) return;
  const acm = new ACMClient({ region: "us-east-1" });
  const printed = new Set<string>();
  while (!signal.aborted) {
    const { CertificateSummaryList = [] } = await acm.send(
      new ListCertificatesCommand({ CertificateStatuses: ["PENDING_VALIDATION"] }),
    );
    const pending = await Promise.all(
      CertificateSummaryList.filter((c) => c.DomainName && domains.includes(c.DomainName)).map(
        (c) =>
          acm
            .send(new DescribeCertificateCommand({ CertificateArn: c.CertificateArn }))
            .then(({ Certificate }) => Certificate),
      ),
    );
    for (const { domain, name, value } of validationRecords(domains, pending)) {
      if (printed.has(name)) continue;
      printed.add(name);
      say(
        `\nThe certificate for ${domain} waits for this record at your DNS host (DNS only):\n  CNAME  ${name}  ${value}\n`,
      );
    }
    await setTimeout(15_000, undefined, { signal }).catch(() => undefined);
  }
}

/** Builds the dashboard (and the project site, if it has a domain), then deploys every stack. */
async function deployStacks(config: Deployment, configPath: string, say: Say) {
  await pnpm(["--filter", "@galena/web", "build"]);
  if (config.siteDomain) await pnpm(["--filter", "@galena/web", "build"], { GLN_SITE: "project" });
  const stop = new AbortController();
  const watching = watchCertificates(config, say, stop.signal).catch((error: unknown) =>
    say(`Couldn't read the certificates' validation records: ${describeError(error)}`),
  );
  try {
    await pnpm([
      "--filter",
      "@galena/infra",
      "exec",
      "cdk",
      "deploy",
      "--all",
      "--require-approval",
      "never",
      "-c",
      `config=${configPath}`,
    ]);
  } finally {
    stop.abort();
    await watching;
  }
}

/**
 * Deploys the config's deployment, or upgrades it: each step checks first and skips what is
 * already done. It prints no secret, and stores the ones it makes only in SSM.
 */
export async function deploy(
  path: string,
  { input, output }: { input?: Readable; output?: Writable } = {},
): Promise<number> {
  const { say, askHidden } = prompter(input, output);
  try {
    const loaded = loadConfig(path);
    const { triggerProjectRef } = loaded;
    if (!triggerProjectRef) {
      throw new Error(
        "Add triggerProjectRef to the config: the workers deploy to that trigger.dev project.",
      );
    }
    const config: Deployment = { ...loaded, triggerProjectRef };
    const node = nodeCheck();
    if (node.status === "fail") throw new Error(node.summary);
    const { account, arn } = await callerIdentity(config.homeRegion);
    say(
      `Deploying ${config.stage} to account ${account} as ${arn}. Running this again upgrades it.`,
    );

    const configPath = resolve(path);
    await bootstrap(config, account, configPath, say);
    await createSecrets(config, await readStacks(config), say, askHidden);
    await deployStacks(config, configPath, say);
    return 0;
  } catch (error) {
    say(describeError(error));
    return 1;
  }
}
