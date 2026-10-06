import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
  paginateDescribeParameters,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { expectedStacks, type StageConfig, stageRegions } from "@galena/infra/config";
import { z } from "zod";

export type Stack = { status?: string; outputs: Record<string, string> };

/** One client per region, made when first needed. */
export function perRegion<T>(make: (region: string) => T): (region: string) => T {
  const made = new Map<string, T>();
  return (region) => {
    const known = made.get(region);
    if (known) return known;
    const client = make(region);
    made.set(region, client);
    return client;
  };
}

export const ssm = perRegion((region) => new SSMClient({ region }));
const cloudFormation = perRegion((region) => new CloudFormationClient({ region }));

const missingParameter = (error: unknown) => {
  if (error instanceof ParameterNotFound) return undefined;
  throw error;
};

/** Who the AWS credentials belong to. */
export async function callerIdentity(region: string): Promise<{ account: string; arn: string }> {
  const { Account, Arn } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  return { account: Account ?? "", arn: Arn ?? "" };
}

/** Stores a new SecureString under `/galena/<stage>/`; one that already exists is kept as is. */
export async function putSecret(config: StageConfig, name: string, value: string): Promise<void> {
  await ssm(config.homeRegion)
    .send(
      new PutParameterCommand({
        Name: `/galena/${config.stage}/${name}`,
        Value: value,
        Type: "SecureString",
        Overwrite: false,
      }),
    )
    .catch((error: unknown) => {
      if (!(error instanceof ParameterAlreadyExists)) throw error;
    });
}

/** Each region's CDK bootstrap version, undefined where CDK isn't bootstrapped. */
export async function bootstrapVersions(
  config: StageConfig,
): Promise<Map<string, string | undefined>> {
  const regions = stageRegions(config);
  const versions = await Promise.all(
    regions.map((region) =>
      ssm(region)
        .send(new GetParameterCommand({ Name: "/cdk-bootstrap/hnb659fds/version" }))
        .then(({ Parameter }) => Parameter?.Value)
        .catch(missingParameter),
    ),
  );
  return new Map(regions.map((region, i) => [region, versions[i]]));
}

/** The names and types of the parameters under `/galena/<stage>/`, never their values. */
export async function parameterTypes(config: StageConfig): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  for await (const page of paginateDescribeParameters(
    { client: ssm(config.homeRegion) },
    {
      ParameterFilters: [{ Key: "Path", Option: "OneLevel", Values: [`/galena/${config.stage}`] }],
    },
  )) {
    for (const { Name, Type } of page.Parameters ?? []) if (Name) types.set(Name, Type ?? "");
  }
  return types;
}

/** A parameter's value, decrypted, to hand on; never print it. Undefined when it's missing. */
export async function parameter(config: StageConfig, name: string): Promise<string | undefined> {
  return ssm(config.homeRegion)
    .send(
      new GetParameterCommand({ Name: `/galena/${config.stage}/${name}`, WithDecryption: true }),
    )
    .then(({ Parameter }) => Parameter?.Value)
    .catch(missingParameter);
}

/** Every stack the config creates, with its status (none when not deployed) and outputs. */
export async function readStacks(config: StageConfig): Promise<Map<string, Stack>> {
  const stacks = new Map<string, Stack>();
  await Promise.all(
    expectedStacks(config).map(async ({ id, region }) => {
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
  return stacks;
}

/**
 * A request to the trigger.dev project's production variables (`path` after `/envvars/prod`;
 * a POST when there is a `body`), signed with the deployment's trigger.dev secret key from SSM.
 */
export async function triggerVariables(
  config: StageConfig & { triggerProjectRef: string },
  path = "",
  body?: unknown,
): Promise<Response> {
  const key = await parameter(config, "trigger-secret-key");
  return fetch(
    `https://api.trigger.dev/api/v1/projects/${config.triggerProjectRef}/envvars/prod${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key ?? ""}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

// trigger.dev lists each variable with its value; parsing keeps the names and drops the rest.
const variables = z.array(z.object({ name: z.string() }));
const variableNames = z
  .union([variables, z.object({ data: variables }).transform(({ data }) => data)])
  .transform((list) => list.map(({ name }) => name));

/** The names of the variables set in the project's production environment. */
export async function triggerVariableNames(
  config: StageConfig & { triggerProjectRef: string },
): Promise<Set<string>> {
  const response = await triggerVariables(config);
  if (!response.ok) {
    throw new Error(
      `trigger.dev answered ${response.status} for ${config.triggerProjectRef}'s production variables`,
    );
  }
  return new Set(variableNames.parse(await response.json()));
}
