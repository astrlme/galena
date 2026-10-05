import { resolveCname } from "node:dns/promises";
import type { Writable } from "node:stream";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient, paginateListTables } from "@aws-sdk/client-dynamodb";
import { GetAccountSettingsCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import {
  GetParameterCommand,
  ParameterNotFound,
  paginateDescribeParameters,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { expectedStacks, loadConfig, type StageConfig, stageRegions } from "@galena/infra/config";
import { z } from "zod";

export type Status = "ok" | "warn" | "fail";
export type Check = { id: string; status: Status; summary: string; details: string[] };
type Finding = Omit<Check, "id">;
type Problem = { status: Status; text: string };
type Stack = { status?: string; outputs: Record<string, string> };

const ok = (summary: string, details: string[] = []): Finding => ({
  status: "ok",
  summary,
  details,
});

/** The worst status among `findings`, which become the details; `summary` says it in a line. */
function judge(summary: string, findings: Problem[]): Finding {
  const statuses = findings.map((f) => f.status);
  const status = statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "ok";
  return { status, summary, details: findings.map((f) => f.text) };
}

/** One client per region, made when first needed. */
function perRegion<T>(make: (region: string) => T): (region: string) => T {
  const made = new Map<string, T>();
  return (region) => {
    const known = made.get(region);
    if (known) return known;
    const client = make(region);
    made.set(region, client);
    return client;
  };
}

const describeError = (error: unknown) =>
  error instanceof Error
    ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
    : String(error);

export function nodeCheck(version = process.versions.node): Finding {
  return Number(version.split(".")[0]) >= 24
    ? ok(`Node ${version}`)
    : { status: "fail", summary: `Node ${version}; Galena needs Node 24 or later`, details: [] };
}

/** How a CloudFormation stack status reads: settled, worth a look, or broken or missing. */
export function stackState(status: string | undefined): Status {
  if (!status || status.endsWith("_FAILED") || status === "ROLLBACK_COMPLETE") return "fail";
  if (status === "UPDATE_ROLLBACK_COMPLETE" || !status.endsWith("_COMPLETE")) return "warn";
  return "ok";
}

/** The secrets made by hand, which the API reads at cold start. */
const SECRETS = ["auth-secret", "app-key", "trigger-secret-key"];

/** The variables the workers read in trigger.dev's production environment. */
export function requiredTriggerEnv(config: StageConfig): string[] {
  return [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GLN_HOME_REGION",
    "GLN_DB_CLUSTER_ARN",
    "GLN_DB_SECRET_ARN",
    "GLN_CONFIG_BUCKET",
    "GLN_PAGE_BUCKET",
    "GLN_PAGE_REGION",
    "GLN_PAGE_URL",
    "GLN_APP_KEY",
    "GLN_TELEMETRY_TABLE",
    "GLN_TRIGGER_PROJECT_REF",
    ...(config.email ? ["GLN_EMAIL_FROM", "GLN_SES_CONFIGURATION_SET"] : []),
  ];
}

// trigger.dev lists each variable with its value; parsing keeps the names and drops the rest.
const variables = z.array(z.object({ name: z.string() }));
const variableNames = z
  .union([variables, z.object({ data: variables }).transform(({ data }) => data)])
  .transform((list) => list.map(({ name }) => name));

type Table = { name: string; read: number; write: number };
const FREE_UNITS = 25;

/** Provisioned capacity in the home region against the always-free 25 read and 25 write units. */
export function capacityCheck(
  tables: Table[],
  region: string,
  planned?: { read: number; write: number },
): Finding {
  const all = planned ? [...tables, { name: "telemetry (not deployed yet)", ...planned }] : tables;
  const total = (unit: "read" | "write") => all.reduce((sum, table) => sum + table[unit], 0);
  const summary = `${total("read")} read and ${total("write")} write units provisioned in ${region}; the free tier covers ${FREE_UNITS} of each`;
  if (total("read") <= FREE_UNITS && total("write") <= FREE_UNITS) return ok(summary);
  return judge(
    summary,
    all
      .filter((table) => table.read || table.write)
      .map((table) => ({
        status: "warn",
        text: `${table.name}: ${table.read} read, ${table.write} write`,
      })),
  );
}

/**
 * Checks a deployment without changing anything: names and states only, never a secret's value.
 * Each check runs after the one before, so the output streams.
 */
function checks(config: StageConfig) {
  const home = config.homeRegion;
  const ssm = perRegion((region) => new SSMClient({ region }));
  const cloudFormation = perRegion((region) => new CloudFormationClient({ region }));
  const stacks = new Map<string, Stack>();

  return [
    ["node", async () => nodeCheck()],
    [
      "aws",
      async () => {
        const { Account, Arn } = await new STSClient({ region: home }).send(
          new GetCallerIdentityCommand({}),
        );
        return ok(`${Arn} in account ${Account}`);
      },
    ],
    [
      "bootstrap",
      async () => {
        const regions = stageRegions(config);
        const versions = await Promise.all(
          regions.map((region) =>
            ssm(region)
              .send(new GetParameterCommand({ Name: "/cdk-bootstrap/hnb659fds/version" }))
              .then(({ Parameter }) => Parameter?.Value)
              .catch((error: unknown) => {
                if (error instanceof ParameterNotFound) return undefined;
                throw error;
              }),
          ),
        );
        const missing = regions.filter((_, i) => !versions[i]);
        return judge(
          missing.length
            ? `${missing.length} of ${regions.length} regions aren't bootstrapped for CDK`
            : `${regions.length} regions bootstrapped for CDK (version ${versions[0]})`,
          missing.map((region) => ({
            status: "fail",
            text: `${region}: run cdk bootstrap aws://<account>/${region}`,
          })),
        );
      },
    ],
    [
      "parameters",
      async () => {
        const prefix = `/galena/${config.stage}`;
        const types = new Map<string, string>();
        for await (const page of paginateDescribeParameters(
          { client: ssm(home) },
          { ParameterFilters: [{ Key: "Path", Option: "OneLevel", Values: [prefix] }] },
        )) {
          for (const { Name, Type } of page.Parameters ?? []) if (Name) types.set(Name, Type ?? "");
        }
        const findings = SECRETS.flatMap((name): Problem[] => {
          const type = types.get(`${prefix}/${name}`);
          if (type === "SecureString") return [];
          return [
            {
              status: "fail",
              text: `${prefix}/${name} ${type ? `is a ${type}, not a SecureString` : "is missing"}`,
            },
          ];
        });
        if (!types.has(`${prefix}/setup-token`)) {
          findings.push({
            status: "warn",
            text: `${prefix}/setup-token is missing; only first-run setup needs it`,
          });
        }
        const good = SECRETS.length - findings.filter((f) => f.status === "fail").length;
        return judge(
          `${good} of ${SECRETS.length} secrets are SecureStrings under ${prefix}/`,
          findings,
        );
      },
    ],
    [
      "stacks",
      async () => {
        const expected = expectedStacks(config);
        await Promise.all(
          expected.map(async ({ id, region }) => {
            const found = await cloudFormation(region)
              .send(new DescribeStacksCommand({ StackName: id }))
              .then(({ Stacks }) => Stacks?.[0])
              // CloudFormation answers a ValidationError for a stack that doesn't exist.
              .catch((error: unknown) => {
                if (error instanceof Error && error.name === "ValidationError") return undefined;
                throw error;
              });
            stacks.set(id, {
              ...(found?.StackStatus ? { status: found.StackStatus } : {}),
              outputs: Object.fromEntries(
                (found?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
              ),
            });
          }),
        );
        const findings = expected.flatMap(({ id, region }) => {
          const status = stacks.get(id)?.status;
          const state = stackState(status);
          return state === "ok"
            ? []
            : [{ status: state, text: `${id} (${region}): ${status ?? "not deployed"}` }];
        });
        return judge(
          `${expected.length - findings.length} of ${expected.length} stacks deployed and settled`,
          findings,
        );
      },
    ],
    [
      "trigger",
      async () => {
        const ref = config.triggerProjectRef;
        if (!ref) {
          return {
            status: "warn",
            summary: "Add triggerProjectRef to the config to check the workers' variables",
            details: [],
          };
        }
        const { Parameter } = await ssm(home).send(
          new GetParameterCommand({
            Name: `/galena/${config.stage}/trigger-secret-key`,
            WithDecryption: true,
          }),
        );
        const response = await fetch(
          `https://api.trigger.dev/api/v1/projects/${ref}/envvars/prod`,
          { headers: { authorization: `Bearer ${Parameter?.Value ?? ""}` } },
        );
        if (!response.ok) {
          return {
            status: "fail",
            summary: `trigger.dev answered ${response.status} for ${ref}'s production variables`,
            details: [],
          };
        }
        const names = new Set(variableNames.parse(await response.json()));
        const required = requiredTriggerEnv(config);
        const missing = required.filter((name) => !names.has(name));
        return judge(
          `${required.length - missing.length} of ${required.length} variables the workers need are set in ${ref}'s production environment`,
          missing.map((name) => ({ status: "fail", text: `${name} is not set` })),
        );
      },
    ],
    [
      "dns",
      async () => {
        const named: [string | undefined, string][] = [
          [config.pageDomain, "page"],
          [config.webDomain, "web"],
          [config.siteDomain, "site"],
        ];
        const domains = named.flatMap(([domain, stack]) =>
          domain ? [{ domain, stack: `galena-${config.stage}-${stack}` }] : [],
        );
        if (!domains.length) return ok("No custom domains; the CloudFront addresses serve");
        const findings = await Promise.all(
          domains.map(async ({ domain, stack }): Promise<Problem[]> => {
            const target = stacks.get(stack)?.outputs.DistributionDomain;
            if (!target) {
              return [
                { status: "fail", text: `${domain}: ${stack} has no CloudFront address yet` },
              ];
            }
            const names = await resolveCname(domain).catch((): string[] => []);
            if (names.some((name) => name.toLowerCase() === target.toLowerCase())) return [];
            return [
              {
                status: "fail",
                text: `${domain} points to ${names.join(", ") || "no CNAME"}; point it at ${target}, DNS only (not proxied)`,
              },
            ];
          }),
        );
        const problems = findings.flat();
        return judge(
          `${domains.length - problems.length} of ${domains.length} domains point at their CloudFront distribution`,
          problems,
        );
      },
    ],
    [
      "email",
      async () => {
        if (!config.email) return ok("Email is off");
        const { domain, from } = config.email;
        const ses = new SESv2Client({ region: home });
        const identity = await ses
          .send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === "NotFoundException") return undefined;
            throw error;
          });
        if (!identity) {
          return {
            status: "fail",
            summary: `${domain} isn't an SES identity in ${home} yet; the email stack creates it`,
            details: [],
          };
        }
        const findings: Problem[] = [];
        if (!identity.VerifiedForSendingStatus) {
          findings.push({ status: "fail", text: `${domain} isn't verified for sending yet` });
        }
        const dkim = identity.DkimAttributes?.Status;
        if (dkim !== "SUCCESS") {
          findings.push({
            status: "fail",
            text: `DKIM is ${dkim ?? "not set up"}; add the three DKIM CNAMEs at your DNS host`,
          });
        }
        const mailFrom = identity.MailFromAttributes?.MailFromDomainStatus;
        if (mailFrom && mailFrom !== "SUCCESS") {
          findings.push({
            status: "warn",
            text: `The MAIL FROM domain is ${mailFrom}; check its MX and SPF records`,
          });
        }
        const { ProductionAccessEnabled } = await ses.send(new GetAccountCommand({}));
        if (!ProductionAccessEnabled) {
          findings.push({
            status: "warn",
            text: `SES in ${home} is in the sandbox: mail reaches verified addresses only until AWS grants production access`,
          });
        }
        return judge(`Sending as ${from}`, findings);
      },
    ],
    [
      "telemetry",
      async () => {
        const dynamo = new DynamoDBClient({ region: home });
        const names: string[] = [];
        for await (const page of paginateListTables({ client: dynamo }, {})) {
          names.push(...(page.TableNames ?? []));
        }
        const tables = await Promise.all(
          names.map(async (name): Promise<Table> => {
            const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: name }));
            const units = [
              Table?.ProvisionedThroughput,
              ...(Table?.GlobalSecondaryIndexes ?? []).map((index) => index.ProvisionedThroughput),
            ];
            return {
              name,
              read: units.reduce((sum, u) => sum + (u?.ReadCapacityUnits ?? 0), 0),
              write: units.reduce((sum, u) => sum + (u?.WriteCapacityUnits ?? 0), 0),
            };
          }),
        );
        const deployed = stacks.get(`galena-${config.stage}-foundation`)?.status !== undefined;
        return capacityCheck(tables, home, deployed ? undefined : config.telemetryCapacity);
      },
    ],
    [
      "lambda",
      async () => {
        const { AccountLimit } = await new LambdaClient({ region: home }).send(
          new GetAccountSettingsCommand({}),
        );
        const limit = AccountLimit?.ConcurrentExecutions ?? 0;
        const summary = `${limit} concurrent Lambda executions allowed in ${home}`;
        if (limit >= 100) return ok(summary);
        return judge(summary, [
          {
            status: "warn",
            text: "The API, the evaluator and every other function share them; ask for 1000 in Service Quotas (AWS Lambda, Concurrent executions)",
          },
        ]);
      },
    ],
  ] satisfies [string, () => Promise<Finding>][];
}

/** One line per check, details indented under it. */
export function formatCheck({ id, status, summary, details }: Check): string {
  const lines = [`${status.padEnd(4)}  ${id.padEnd(10)}  ${summary}`];
  for (const detail of details) lines.push(`${" ".repeat(18)}${detail}`);
  return `${lines.join("\n")}\n`;
}

export async function doctor(
  path: string,
  { json = false, output = process.stdout }: { json?: boolean; output?: Writable } = {},
): Promise<number> {
  let config: StageConfig;
  try {
    config = loadConfig(path);
  } catch (error) {
    output.write(`${describeError(error)}\n`);
    return 1;
  }
  if (!json) output.write(`Checking ${config.stage}, home region ${config.homeRegion}\n\n`);
  const results: Check[] = [];
  for (const [id, run] of checks(config)) {
    const found = await run().catch(
      (error: unknown): Finding => ({
        status: "fail",
        summary: `Couldn't check: ${describeError(error)}`,
        details: [],
      }),
    );
    const check = { id, ...found };
    results.push(check);
    if (!json) output.write(formatCheck(check));
    // Without working AWS credentials every later check would fail the same way.
    if (id === "aws" && check.status === "fail") break;
  }
  const count = (status: Status) => results.filter((c) => c.status === status).length;
  output.write(
    json
      ? `${JSON.stringify(results, null, 2)}\n`
      : `\n${count("fail")} failed, ${count("warn")} to look at, ${count("ok")} ok\n`,
  );
  return count("fail") ? 1 : 0;
}
