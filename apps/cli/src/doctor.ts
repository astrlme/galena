import type { Writable } from "node:stream";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  GetParameterCommand,
  ParameterNotFound,
  paginateDescribeParameters,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { expectedStacks, loadConfig, type StageConfig, stageRegions } from "@galena/infra/config";

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
