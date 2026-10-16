import { execFileSync } from "node:child_process";
import {
  AssetHashType,
  DockerImage,
  Duration,
  Size,
  Stack,
  type StackProps,
  Token,
  Validations,
} from "aws-cdk-lib";
import { type IRole, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";
import { dataApiAccess } from "./data-api.ts";
import { jobAccess } from "./job-access.ts";
import { pageBucketName } from "./status-page.ts";

/**
 * The background jobs on Lambda, fed by Foundation's FIFO queues: one function for every job but
 * the HTML build, and the builder, which carries the status app to run `astro build`.
 */
export class JobsStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: StageConfig;
      /** Where readers find the status page, for links in feeds, emails and chat messages. */
      pageUrl: string;
    },
  ) {
    super(scope, id, props);
    const { config } = props;
    const { stage } = config;
    // Foundation publishes these; reading them at deploy time keeps the stacks free of exports.
    const param = (name: string) =>
      StringParameter.valueForStringParameter(this, `/galena/${stage}/${name}`);
    const queue = (name: string) => ({
      url: param(`${name}-queue-url`),
      arn: param(`${name}-queue-arn`),
      deadLetterUrl: param(`${name}-dead-letter-url`),
      deadLetterArn: param(`${name}-dead-letter-arn`),
    });
    const jobs = queue("jobs");
    const builds = queue("builds");
    const access = jobAccess(this, stage);
    const configBucket = `arn:${this.partition}:s3:::${param("config-bucket")}`;
    const pageBucket = `arn:${this.partition}:s3:::${pageBucketName(stage, this.account)}`;
    const appKey = `/galena/${stage}/app-key`;
    const database = dataApiAccess(this, stage);

    // What both functions read: the database, the page bucket, their queue and its dead letters.
    const shared = (reads: ReturnType<typeof queue>) => ({
      ...database.environment,
      GLN_HOME_REGION: this.region,
      GLN_PAGE_BUCKET: pageBucketName(stage, this.account),
      GLN_PAGE_REGION: config.pageRegions.primary,
      GLN_QUEUE_URL: reads.url,
      GLN_DEAD_LETTER_URL: reads.deadLetterUrl,
    });

    // What both functions may do: write the page's files and read snapshot.json back (listing
    // lets a missing file read as absent rather than forbidden), and set aside a message that
    // failed for good.
    const grantShared = (role: IRole, reads: ReturnType<typeof queue>) => {
      for (const statement of [
        new PolicyStatement({
          actions: ["s3:PutObject", "s3:GetObject"],
          resources: [`${pageBucket}/pages/*`],
        }),
        new PolicyStatement({ actions: ["s3:ListBucket"], resources: [pageBucket] }),
        new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [reads.deadLetterArn] }),
      ]) {
        role.addToPrincipalPolicy(statement);
      }
    };

    const jobsLogs = new LogGroup(this, "JobsLogs", { retention: RetentionDays.ONE_MONTH });
    const jobsRole = database.role("JobsRole", jobsLogs);
    grantShared(jobsRole, jobs);
    for (const statement of [
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: appKey.slice(1) }),
        ],
      }),
      // outbox.dispatch rebuilds monitors.json after every monitor change.
      new PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${configBucket}/monitors.json`],
      }),
      // page.publish notes which monitor states the page shows; page.heartbeat reads the note
      // back. Listing lets the note read as absent, not forbidden, before the first publish.
      new PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [`${configBucket}/published.json`],
      }),
      new PolicyStatement({ actions: ["s3:ListBucket"], resources: [configBucket] }),
      // rollup.uptime catches monitor states up with what the evaluator wrote; read only.
      new PolicyStatement({
        actions: ["dynamodb:BatchGetItem"],
        resources: [
          this.formatArn({
            service: "dynamodb",
            resource: "table",
            resourceName: param("telemetry-table"),
          }),
        ],
      }),
    ]) {
      jobsRole.addToPrincipalPolicy(statement);
    }
    // Jobs start other jobs: now on either queue, later through a one-time schedule.
    access.grant(jobsRole, { builds: true, schedule: true });
    // notify.email sends as the stage's identity, through its configuration set only.
    if (config.email) {
      jobsRole.addToPrincipalPolicy(
        new PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [
            this.formatArn({
              service: "ses",
              resource: "identity",
              resourceName: config.email.domain,
            }),
            this.formatArn({
              service: "ses",
              resource: "configuration-set",
              resourceName: `galena-${stage}`,
            }),
          ],
        }),
      );
    }
    const jobsFunction = new NodejsFunction(this, "Jobs", {
      entry: source("apps/workers/src/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // A sixth of the queue's visibility timeout; the slowest job waits ~20 s for Aurora.
      timeout: Duration.minutes(2),
      role: jobsRole,
      logGroup: jobsLogs,
      environment: {
        ...shared(jobs),
        GLN_CONFIG_BUCKET: param("config-bucket"),
        GLN_TELEMETRY_TABLE: param("telemetry-table"),
        GLN_PAGE_URL: props.pageUrl,
        // Where Slack messages link to; the Web stack writes it.
        GLN_DASHBOARD_URL: param("public-url"),
        ...(config.email
          ? { GLN_EMAIL_FROM: config.email.from, GLN_SES_CONFIGURATION_SET: `galena-${stage}` }
          : {}),
        GLN_APP_KEY_PARAM: appKey,
        ...access.environment,
      },
      bundling,
    });
    // One message per call, so a failure retries only itself; ten lanes at a time at most.
    jobsFunction.addEventSource(
      new SqsEventSource(
        Queue.fromQueueAttributes(this, "JobsQueue", { queueArn: jobs.arn, fifo: true }),
        { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 10 },
      ),
    );

    const builderLogs = new LogGroup(this, "BuilderLogs", { retention: RetentionDays.ONE_MONTH });
    // The builder runs Astro and Vite, so it gets no more than a build needs: no app key, no
    // config bucket, no email, no Scheduler.
    const builderRole = database.role("BuilderRole", builderLogs);
    grantShared(builderRole, builds);
    const builder = new LambdaFunction(this, "Builder", {
      // Not a NodejsFunction: index.mjs ships beside a production install of the status app,
      // built for this runtime by scripts/package-builder.ts. Hashed by its output, so an
      // unchanged build uploads nothing.
      code: Code.fromAsset(source("scripts"), {
        assetHashType: AssetHashType.OUTPUT,
        bundling: {
          // Never used: the local build always runs, or fails the synth.
          image: DockerImage.fromRegistry("public.ecr.aws/lambda/nodejs:24"),
          local: {
            tryBundle(outputDir) {
              execFileSync(process.execPath, [source("scripts/package-builder.ts"), outputDir], {
                stdio: "inherit",
              });
              return true;
            },
          },
        },
      }),
      handler: "index.handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      // A little over one vCPU (1,769 MB buys one) for Vite; the build and its caches use /tmp.
      memorySize: 2048,
      ephemeralStorageSize: Size.gibibytes(1),
      timeout: Duration.minutes(5),
      role: builderRole,
      logGroup: builderLogs,
      environment: { ...shared(builds), NODE_OPTIONS: "--enable-source-maps" },
    });
    builder.addEventSource(
      new SqsEventSource(
        Queue.fromQueueAttributes(this, "BuildsQueue", { queueArn: builds.arn, fifo: true }),
        { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 2 },
      ),
    );

    // cdk-nag names a wildcard by its resource as synthesised: tokens become placeholders.
    const asNagShows = (value: string, placeholder: string) =>
      Token.isUnresolved(value) ? placeholder : value;
    const account = asNagShows(this.account, "<AWS::AccountId>");
    for (const partition of ["aws", "<AWS::Partition>"]) {
      for (const role of [jobsRole, builderRole]) {
        Validations.of(role).acknowledge({
          id: `AwsSolutions-IAM5[Resource::arn:${partition}:s3:::${pageBucketName(stage, account)}/pages/*]`,
          reason:
            "The page's files are named by incident and build hash, so publishing writes any key under pages/.",
        });
      }
    }
  }
}
