import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { ApiStack } from "../stacks/api.ts";
import { fixture } from "./fixture.ts";

// Skip esbuild here; `pnpm infra:synth` bundles for real.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const template = Template.fromStack(
  new ApiStack(app, "Api", { config: fixture, version: "1.2.3" }),
);

test("records the release it deploys where galena deploy reads it, once migrations ran", () => {
  const [[id, parameter] = []] = Object.entries(
    template.findResources("AWS::SSM::Parameter", {
      Properties: { Name: `/galena/${fixture.stage}/version` },
    }),
  );
  expect(parameter?.Properties).toMatchObject({ Type: "String", Value: "1.2.3" });
  expect(parameter?.DependsOn).toEqual(
    expect.arrayContaining([expect.stringMatching(/^MigrateOnDeploy/)]),
  );
  expect(id).toBeDefined();
});

test("runs the API on Node 24 arm64 Lambda outside any VPC", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    Timeout: 29,
  });
  for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
});

test("the API and migration roles get logs, the Data API, their secrets and telemetry reads", () => {
  const roles = Object.entries(template.findResources("AWS::IAM::Role")).filter(([id]) =>
    /^(Handler|Migrate)Role/.test(id),
  );
  expect(roles).toHaveLength(2);
  for (const [, role] of roles) expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
    p.Properties.Roles.some((r: { Ref: string }) => /^(Handler|Migrate)Role/.test(r.Ref)),
  );
  const actions = new Set(
    policies.flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: unknown }) => [s.Action].flat()),
    ),
  );
  expect([...actions].sort()).toEqual([
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "iam:PassRole",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "scheduler:CreateSchedule",
    "secretsmanager:DescribeSecret",
    "secretsmanager:GetSecretValue",
    "sqs:SendMessage",
    "ssm:GetParameter",
    "ssm:PutParameter",
  ]);
});

test("only the migrations write, and only their schema record", () => {
  const writes = Object.entries(template.findResources("AWS::IAM::Policy")).flatMap(([, p]) =>
    p.Properties.PolicyDocument.Statement.filter((s: { Action: unknown }) =>
      [s.Action].flat().includes("ssm:PutParameter"),
    ).map((s: { Resource: unknown }) => ({ roles: p.Properties.Roles, resource: s.Resource })),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]?.roles).toEqual([{ Ref: expect.stringMatching(/^MigrateRole/) }]);
  expect(JSON.stringify(writes[0]?.resource)).toContain(
    `:parameter/galena/${fixture.stage}/schema`,
  );
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({ GLN_SCHEMA_PARAM: `/galena/${fixture.stage}/schema` }),
    },
  });
});

test("generates the origin secret, copies it to the page region, and the API reads it via SSM", () => {
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "galena/dev/origin-secret",
    GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
    ReplicaRegions: [{ Region: fixture.pageRegions.primary }],
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 29,
    Environment: {
      Variables: {
        GLN_ORIGIN_SECRET_PARAM: "/aws/reference/secretsmanager/galena/dev/origin-secret",
      },
    },
  });
});

test("the API reads its database and job queues from Foundation's parameters and its secrets from SSM", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 29,
    Environment: {
      Variables: {
        GLN_STAGE: "dev",
        GLN_DB_NAME: "galena",
        GLN_AUTH_SECRET_PARAM: "/galena/dev/auth-secret",
        GLN_SCHEDULE_GROUP: "galena-dev-jobs",
        GLN_APP_KEY_PARAM: "/galena/dev/app-key",
        GLN_SETUP_TOKEN_PARAM: "/galena/dev/setup-token",
        GLN_SLACK_APP_PARAM: "/galena/dev/slack-app",
        GLN_PUBLIC_URL_PARAM: "/galena/dev/public-url",
        GLN_PROBE_REGIONS: "eu-west-1,eu-west-3,eu-north-1",
        GLN_EMAIL_FROM: "status@mail.example.com",
      },
    },
  });
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  for (const name of ["auth-secret", "app-key", "setup-token", "slack-app"]) {
    expect(policies).toContain(`parameter/galena/dev/${name}`);
  }
  const fn = Object.values(template.findResources("AWS::Lambda::Function")).find(
    (f) => f.Properties.Environment?.Variables?.GLN_AUTH_SECRET_PARAM,
  );
  expect(Object.keys(fn?.Properties.Environment.Variables ?? {})).toEqual(
    expect.arrayContaining(["GLN_JOBS_QUEUE_URL", "GLN_SCHEDULE_DEAD_LETTER_ARN"]),
  );
});

test("migrations run on deploy through a trigger with room for Aurora to resume", () => {
  template.resourceCountIs("Custom::Trigger", 1);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Handler: "index.handler",
    Timeout: 120,
  });
});

test("throttles the stage at 20 requests a second, and the paths open to anyone lower", () => {
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    RouteSettings: {
      "ANY /auth/{proxy+}": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      "ANY /public/{proxy+}": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
      "ANY /hooks/{proxy+}": { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
      "ANY /slack/{proxy+}": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    },
    AccessLogSettings: {},
  });
  for (const key of ["/auth", "/public", "/hooks", "/slack"]) {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: `ANY ${key}/{proxy+}`,
    });
  }
});

test("alarms when the API answers far more requests in an hour than a dashboard makes", () => {
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "Count",
    Namespace: "AWS/ApiGateway",
    Statistic: "Sum",
    Period: 3600,
    Threshold: 5000,
    ComparisonOperator: "GreaterThanThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [{ Ref: Match.stringLikeRegexp("alarmtopicarn") }],
  });
});

test("alarms as soon as the API logs a job it couldn't start", () => {
  template.hasResourceProperties("AWS::Logs::MetricFilter", {
    FilterPattern: '"was not triggered"',
    MetricTransformations: [
      { MetricNamespace: "Galena", MetricName: "untriggered_jobs", MetricValue: "1" },
    ],
  });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "untriggered_jobs",
    Namespace: "Galena",
    Statistic: "Sum",
    Period: 300,
    Threshold: 1,
    EvaluationPeriods: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [{ Ref: Match.stringLikeRegexp("alarmtopicarn") }],
  });
});

test("one dashboard shows the probes, detection, the queues, the jobs, the API and Aurora", () => {
  const dashboards = Object.values(template.findResources("AWS::CloudWatch::Dashboard"));
  expect(dashboards).toHaveLength(1);
  expect(dashboards[0]?.Properties.DashboardName).toBe("galena-dev");
  const body = JSON.stringify(dashboards[0]?.Properties.DashboardBody);
  for (const title of [
    "Checks by probe region",
    "Check results sent",
    "Evaluator",
    "Oldest message in each queue (s)",
    "Dead letters",
    "Jobs and builds",
    "API requests",
    "API latency (ms)",
    "Aurora capacity (ACU)",
  ]) {
    expect(body).toContain(`\\"title\\":\\"${title}\\"`);
  }
  // Other stacks' functions and queues are found by name: only this deployment's.
  expect(body).toContain("FunctionName=galena-dev-detection-Evaluator");
  expect(body).toContain("QueueName=galena-dev-foundation-CheckResults NOT Dlq");
  expect(body).toContain("QueueName=galena-dev-foundation NOT Dlq");
  // Each probe region's own metrics, read in that region.
  for (const region of fixture.probeRegions) {
    expect(body).toContain(`[\\"Galena\\",\\"checks\\",\\"region\\",\\"${region}\\"`);
  }
  // The API by its id, Aurora by the cluster identifier at the end of its ARN.
  expect(body).toMatch(/AWS\/ApiGateway\\",\\"Count\\",\\"ApiId\\"/);
  expect(body).toMatch(/ServerlessDatabaseCapacity\\",\\"DBClusterIdentifier/);
  expect(body).toContain('"Fn::Select":[6,{"Fn::Split":[":"');
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});

test("only the API's own role reads telemetry, and it never writes it", () => {
  const statements: { roles: string[]; actions: string[] }[] = Object.values(
    template.findResources("AWS::IAM::Policy"),
  ).flatMap((p) =>
    p.Properties.PolicyDocument.Statement.map((s: { Action: string | string[] }) => ({
      roles: p.Properties.Roles.map((r: { Ref: string }) => r.Ref),
      actions: [s.Action].flat(),
    })),
  );
  const dynamo = statements.filter((s) => s.actions.some((a) => a.startsWith("dynamodb:")));
  expect(dynamo).toHaveLength(1);
  expect(dynamo[0]?.roles).toEqual([expect.stringMatching(/^HandlerRole/)]);
  expect(dynamo[0]?.actions.sort()).toEqual(["dynamodb:BatchGetItem", "dynamodb:Query"]);
});
