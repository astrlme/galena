import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { type StageConfig, stageSchema } from "@galena/infra/config";
import type { ZodType } from "zod";

type Regions = Pick<StageConfig, "homeRegion" | "probeRegions" | "pageRegions">;

/** Where a deployment runs. The page never shares a region with the API, or with its replica. */
export const PRESETS = {
  eu: {
    homeRegion: "eu-central-1",
    probeRegions: ["eu-west-1", "eu-west-3", "eu-north-1"],
    pageRegions: { primary: "eu-west-1", replica: "eu-north-1" },
  },
  us: {
    homeRegion: "us-east-2",
    probeRegions: ["us-east-1", "us-west-1", "us-west-2"],
    pageRegions: { primary: "us-west-2", replica: "us-east-1" },
  },
} satisfies Record<string, Regions>;

export type Answers = {
  stage: string;
  preset: keyof typeof PRESETS;
  pageDomain?: string;
  webDomain?: string;
  emailDomain?: string;
  emailFrom?: string;
  triggerProjectRef?: string;
};

/** The config `init` writes: the answers, a preset's regions, and capacity inside the free tier. */
export function buildConfig(answers: Answers): StageConfig {
  const { stage, preset, pageDomain, webDomain, emailDomain, emailFrom, triggerProjectRef } =
    answers;
  return stageSchema.parse({
    stage,
    ...PRESETS[preset],
    ...(pageDomain ? { pageDomain } : {}),
    ...(webDomain ? { webDomain } : {}),
    ...(emailDomain
      ? { email: { domain: emailDomain, from: emailFrom || `status@${emailDomain}` } }
      : {}),
    ...(triggerProjectRef ? { triggerProjectRef } : {}),
    telemetryCapacity: { read: 5, write: 5 },
    auroraMaxAcu: 2,
  });
}

type Check = (answer: string) => string | undefined;

/** Why the config would refuse `value` there, if it would. */
const refusal = (schema: ZodType, value: unknown) => {
  const { error } = schema.safeParse(value);
  return error && `That doesn't work: ${error.issues[0]?.message}.`;
};

/** An answer the config field accepts, or blank when the field is optional. */
const field =
  (schema: ZodType, optional = true): Check =>
  (answer) =>
    optional && answer === "" ? undefined : refusal(schema, answer);

/**
 * Asks for each setting, then writes the config to `path`. Reads answers line by line, so they
 * can be piped in as well as typed.
 */
export async function init(
  path: string,
  {
    force = false,
    input = process.stdin,
    output = process.stdout,
  }: { force?: boolean; input?: Readable; output?: Writable } = {},
): Promise<number> {
  const say = (text: string) => output.write(`${text}\n`);
  if (existsSync(path) && !force) {
    say(`${path} already exists. Run galena init --force to replace it.`);
    return 1;
  }
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  const ask = async (question: string, check: Check, fallback = "") => {
    for (;;) {
      output.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
      const next = await lines.next();
      if (next.done) throw new Error("The answers ended before every question was asked.");
      const answer = (next.value as string).trim() || fallback;
      const problem = check(answer);
      if (problem === undefined) return answer;
      say(problem);
    }
  };
  const { shape } = stageSchema;
  try {
    const stage = await ask(
      "Deployment name, used in stack and parameter names",
      field(shape.stage, false),
      "prod",
    );
    const preset = (await ask(
      "Regions: eu or us",
      (answer) => (answer in PRESETS ? undefined : "Answer eu or us."),
      "eu",
    )) as keyof typeof PRESETS;
    const pageDomain = await ask(
      "Status page domain, or blank for its CloudFront address",
      field(shape.pageDomain),
    );
    const webDomain = await ask(
      "Dashboard domain, or blank for its CloudFront address",
      field(shape.webDomain),
    );
    const emailDomain = await ask(
      "Domain email is sent from, or blank to send no email",
      field(shape.email.unwrap().shape.domain),
    );
    const emailFrom = emailDomain
      ? await ask(
          "Send email as",
          (from) => refusal(shape.email, { domain: emailDomain, from }),
          `status@${emailDomain}`,
        )
      : "";
    const triggerProjectRef = await ask(
      "trigger.dev project ref (proj_…), or blank to add it later",
      field(shape.triggerProjectRef),
    );
    const config = buildConfig({
      stage,
      preset,
      pageDomain,
      webDomain,
      emailDomain,
      emailFrom,
      triggerProjectRef,
    });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    say(`Wrote ${path}. Next: pnpm galena doctor checks your AWS account against it.`);
    return 0;
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
