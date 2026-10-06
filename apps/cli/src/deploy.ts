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
import { CreateAccessKeyCommand, IAMClient, ListAccessKeysCommand } from "@aws-sdk/client-iam";
import { loadConfig, type StageConfig } from "@galena/infra/config";
import { z } from "zod";
import {
  bootstrapVersions,
  callerIdentity,
  deleteParameter,
  parameter,
  parameterTypes,
  putSecret,
  readStacks,
  type Stack,
  triggerVariableNames,
  triggerVariables,
} from "./aws.ts";
import { describeError, doctor, nodeCheck } from "./doctor.ts";
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

type Sources = {
  /** Foundation's parameters, by name under `/galena/<stage>/`. */
  parameters: Record<string, string | undefined>;
  stacks: Map<string, Stack>;
  appKey: string;
  /** Only when deploy just made it: trigger.dev never hands a secret back. */
  accessKey?: { id: string; secret: string };
};

/** The parameters Foundation writes that the workers read. */
const FOUNDATION_PARAMETERS = [
  "database-cluster-arn",
  "database-secret-arn",
  "config-bucket",
  "telemetry-table",
];

const need = (from: Record<string, string | undefined>, key: string) => {
  const value = from[key];
  if (!value) throw new Error(`${key} is missing; run deploy again once every stack is deployed.`);
  return value;
};

/** The workers' variables in trigger.dev: plain ones, and secret ones trigger.dev never shows. */
export function workerVariables(config: Deployment, sources: Sources) {
  const outputs = (stack: string) =>
    sources.stacks.get(`galena-${config.stage}-${stack}`)?.outputs ?? {};
  const page = outputs("page");
  const plain: Record<string, string> = {
    GLN_HOME_REGION: config.homeRegion,
    GLN_DB_CLUSTER_ARN: need(sources.parameters, "database-cluster-arn"),
    GLN_DB_SECRET_ARN: need(sources.parameters, "database-secret-arn"),
    GLN_CONFIG_BUCKET: need(sources.parameters, "config-bucket"),
    GLN_TELEMETRY_TABLE: need(sources.parameters, "telemetry-table"),
    GLN_PAGE_BUCKET: need(page, "PageBucket"),
    GLN_PAGE_REGION: config.pageRegions.primary,
    GLN_PAGE_URL: `https://${config.pageDomain ?? need(page, "DistributionDomain")}`,
    GLN_TRIGGER_PROJECT_REF: config.triggerProjectRef,
  };
  if (config.email) {
    plain.GLN_EMAIL_FROM = config.email.from;
    plain.GLN_SES_CONFIGURATION_SET = need(outputs("email"), "ConfigurationSetName");
  }
  const secret: Record<string, string> = { GLN_APP_KEY: sources.appKey };
  if (sources.accessKey) {
    secret.AWS_ACCESS_KEY_ID = sources.accessKey.id;
    secret.AWS_SECRET_ACCESS_KEY = sources.accessKey.secret;
  }
  return { plain, secret };
}

/** A new key for the workers' IAM user, when trigger.dev doesn't have one yet. */
async function workerKey(config: Deployment) {
  const iam = new IAMClient({ region: config.homeRegion });
  const user = `galena-${config.stage}-worker-access`;
  const { AccessKeyMetadata = [] } = await iam.send(new ListAccessKeysCommand({ UserName: user }));
  if (AccessKeyMetadata.length >= 2) {
    throw new Error(
      `${user} already has two access keys and trigger.dev has neither. Delete one in IAM, then run deploy again.`,
    );
  }
  const { AccessKey } = await iam.send(new CreateAccessKeyCommand({ UserName: user }));
  if (!AccessKey?.AccessKeyId || !AccessKey.SecretAccessKey) {
    throw new Error(`IAM made no access key for ${user}.`);
  }
  return { id: AccessKey.AccessKeyId, secret: AccessKey.SecretAccessKey };
}

/** Sets the workers' variables in trigger.dev's production environment, then deploys them. */
async function deployWorkers(config: Deployment, say: Say) {
  const ref = config.triggerProjectRef;
  const existing = await triggerVariableNames(config);
  const accessKey = existing.has("AWS_ACCESS_KEY_ID") ? undefined : await workerKey(config);
  const appKey = await parameter(config, "app-key");
  if (!appKey) throw new Error(`/galena/${config.stage}/app-key is missing.`);
  const parameters = Object.fromEntries(
    await Promise.all(
      FOUNDATION_PARAMETERS.map(async (name) => [name, await parameter(config, name)] as const),
    ),
  );
  const { plain, secret } = workerVariables(config, {
    parameters,
    stacks: await readStacks(config),
    appKey,
    ...(accessKey ? { accessKey } : {}),
  });
  for (const [variables, isSecret] of [
    [secret, true],
    [plain, false],
  ] as const) {
    const response = await triggerVariables(config, "/import", {
      variables,
      override: true,
      isSecret,
    });
    if (!response.ok) {
      throw new Error(`trigger.dev answered ${response.status} when setting ${ref}'s variables.`);
    }
  }
  say(
    `Set ${Object.keys(plain).length + Object.keys(secret).length} variables in ${ref}'s production environment${accessKey ? ", with a new access key for the workers" : ""}.`,
  );
  // The flag and the variable both name the project, so a local .env can't point elsewhere.
  await pnpm(["--filter", "@galena/workers", "exec", "trigger", "deploy", "--project-ref", ref], {
    GLN_TRIGGER_PROJECT_REF: ref,
  });
}

/** Answers worth another try: the API starting, or Aurora resuming behind it. */
export const retryable = (status: number) => status === 502 || status === 503 || status === 504;

/**
 * Creates the workspace and its owner through first-run setup, while the one-time setup token
 * exists, then deletes the token.
 */
async function createOwner(
  config: Deployment,
  stacks: Map<string, Stack>,
  { say, ask, askHidden }: ReturnType<typeof prompter>,
) {
  const token = await parameter(config, "setup-token");
  if (!token) return say("The deployment has its owner.");
  // The dashboard's CloudFront address works before any DNS record does.
  const dashboard = need(
    stacks.get(`galena-${config.stage}-web`)?.outputs ?? {},
    "DistributionDomain",
  );
  say("\nNow the owner: the first person to sign in.");
  const filled = (answer: string) => (answer ? undefined : "This one is needed.");
  const workspaceName = await ask("Workspace name, as the dashboard shows it", filled);
  const name = await ask("Your name", filled);
  const email = await ask("Your email", (answer) =>
    z.email().safeParse(answer).success ? undefined : "That doesn't look like an email address.",
  );
  const password = await askHidden("Password, at least 12 characters", (answer) =>
    answer.length >= 12 && answer.length <= 128 ? undefined : "Use 12 to 128 characters.",
  );
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://${dashboard}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-galena-setup-token": token },
      body: JSON.stringify({ workspaceName, name, email, password }),
    });
    if (retryable(response.status) && attempt < 4) {
      say("The API is still starting; trying again in 10 seconds.");
      await setTimeout(10_000);
      continue;
    }
    if (response.status === 201 || response.status === 409) {
      await deleteParameter(config, "setup-token");
      return say(
        response.status === 201
          ? `Created ${workspaceName}, owned by ${email}.`
          : "The deployment already had an owner.",
      );
    }
    const problem = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      `First-run setup answered ${response.status}${problem.detail ? `: ${problem.detail}` : ""}. Run deploy again to retry.`,
    );
  }
}

/** The records the DNS host still needs: domains to their distributions, then email's. */
export function dnsRecords(config: StageConfig, stacks: Map<string, Stack>): string[] {
  const outputs = (stack: string) => stacks.get(`galena-${config.stage}-${stack}`)?.outputs ?? {};
  const domains: [string | undefined, string][] = [
    [config.pageDomain, "page"],
    [config.webDomain, "web"],
    [config.siteDomain, "site"],
  ];
  const records = domains.flatMap(([domain, stack]) => {
    const target = outputs(stack).DistributionDomain;
    return domain && target ? [`CNAME  ${domain}  ${target}`] : [];
  });
  // The email stack's outputs read `name -> value`.
  const email = outputs("email");
  const kinds: [string, string][] = [
    ["DkimCname1", "CNAME"],
    ["DkimCname2", "CNAME"],
    ["DkimCname3", "CNAME"],
    ["MailFromMx", "MX"],
    ["MailFromSpf", "TXT"],
    ["Dmarc", "TXT"],
  ];
  for (const [output, kind] of kinds) {
    const [name, value] = email[output]?.split(" -> ") ?? [];
    if (name && value) records.push(`${kind.padEnd(5)}  ${name}  ${value}`);
  }
  return records;
}

function summarize(config: Deployment, stacks: Map<string, Stack>, say: Say) {
  const outputs = (stack: string) => stacks.get(`galena-${config.stage}-${stack}`)?.outputs ?? {};
  const page = config.pageDomain ?? outputs("page").DistributionDomain;
  say(`\nDashboard: ${outputs("web").DashboardUrl ?? "not deployed"}`);
  say(`Status page: ${page ? `https://${page}` : "not deployed"}`);
  const records = dnsRecords(config, stacks);
  if (records.length) {
    say("\nAt your DNS host, DNS only (skip any that already exist):");
    for (const record of records) say(`  ${record}`);
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
  const prompt = prompter(input, output);
  const { say, askHidden } = prompt;
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
    await deployWorkers(config, say);
    const stacks = await readStacks(config);
    await createOwner(config, stacks, prompt);
    summarize(config, stacks, say);
  } catch (error) {
    say(describeError(error));
    return 1;
  }
  say("\nChecking the deployment:\n");
  await doctor(path, output ? { output } : {});
  return 0;
}
