import { Duration, Fn } from "aws-cdk-lib";
import type { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import {
  Dashboard,
  GraphWidget,
  type IMetric,
  MathExpression,
  Metric,
} from "aws-cdk-lib/aws-cloudwatch";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

const period = Duration.minutes(5);

/**
 * Every metric of `schema` matching `terms`, one line each, labelled by its own name unless
 * `label` names a single one. Other stacks' functions and queues are found this way, so no stack
 * exports anything for a graph.
 */
const search = (schema: string, terms: string, statistic: string, label = "") =>
  new MathExpression({
    expression: `SEARCH('${schema} ${terms}', '${statistic}', ${period.toSeconds()})`,
    usingMetrics: {},
    label,
    period,
  });

/** A Powertools metric of the probe in `region`, where the probe publishes it. */
const probeMetric = (metricName: string, region: string) =>
  new Metric({
    namespace: "Galena",
    metricName,
    dimensionsMap: { region, service: "probe" },
    region,
    statistic: "Sum",
    label: region,
    period,
  });

const plot = (title: string, left: IMetric[], right: IMetric[] = []) =>
  new GraphWidget({ title, left, right, width: 12, height: 6 });

/**
 * One CloudWatch dashboard for the deployment, `galena-<stage>`, from metrics that already exist:
 * no new custom metrics, and one dashboard of the three the free tier covers. The alarms watch
 * the same metrics; this shows the trend behind them.
 *
 * Known limit: other stacks' functions and queues are matched by name, and the `Galena` metrics
 * carry no stage, so a second deployment in this account and region shows in this dashboard too
 * (by name only when its stage starts with this one's, `dev` and `dev2`). Give the functions and
 * queues fixed names, and the metrics a `stage` dimension, if two deployments ever share one.
 */
export function addDashboard(
  scope: Construct,
  {
    stage,
    probeRegions,
    api,
    handler,
    untriggeredJobs,
    clusterArn,
  }: {
    stage: string;
    probeRegions: readonly string[];
    api: HttpApi;
    handler: IFunction;
    untriggeredJobs: Metric;
    /** The Aurora cluster's ARN; its last part is the identifier its metrics carry. */
    clusterArn: string;
  },
) {
  // Search terms for the names CDK gives other stacks' resources: `galena-<stage>-<stack>-<id>…`.
  // Renaming a construct id these name (Evaluator, CheckResults, Jobs) empties its graph.
  const functionsNamed = (name: string) => `FunctionName=galena-${stage}-${name}`;
  const queueNames = `QueueName=galena-${stage}-foundation`;
  return new Dashboard(scope, "Dashboard", {
    dashboardName: `galena-${stage}`,
    defaultInterval: Duration.days(1),
    widgets: [
      [
        // A region that stops sending drops out here before the evaluator notices.
        plot(
          "Checks by probe region",
          probeRegions.map((region) => probeMetric("checks", region)),
          probeRegions.map((region) => probeMetric("canary_failed", region)),
        ),
        plot("Check results sent", [
          search(
            "{AWS/SQS,QueueName}",
            `MetricName="NumberOfMessagesSent" ${queueNames}-CheckResults NOT Dlq`,
            "Sum",
          ),
        ]),
      ],
      [
        plot("Evaluator", [
          search(
            "{AWS/Lambda,FunctionName}",
            `MetricName="Errors" ${functionsNamed("detection-Evaluator")}`,
            "Sum",
            "Errors",
          ),
          search(
            "{AWS/Lambda,FunctionName}",
            `MetricName="Throttles" ${functionsNamed("detection-Evaluator")}`,
            "Sum",
            "Throttles",
          ),
          search("{Galena,region,service}", `MetricName="transitions"`, "Sum", "Transitions"),
          // The monitor held its state: fewer regions reported than the quorum needs.
          search(
            "{Galena,region,service}",
            `MetricName="probe_degraded"`,
            "Sum",
            "Short of quorum",
          ),
        ]),
        plot("Oldest message in each queue (s)", [
          search(
            "{AWS/SQS,QueueName}",
            // Dead letters wait up to 14 days on purpose; they have their own graph.
            `MetricName="ApproximateAgeOfOldestMessage" ${queueNames} NOT Dlq`,
            "Maximum",
          ),
        ]),
      ],
      [
        // A job that fails for good lands in its dead-letter queue; the functions' errors are
        // crashes and timeouts only, since the host reports failed jobs per message.
        plot("Dead letters", [
          search(
            "{AWS/SQS,QueueName}",
            `MetricName="ApproximateNumberOfMessagesVisible" ${queueNames} Dlq`,
            "Maximum",
          ),
        ]),
        plot("Jobs and builds", [
          search(
            "{AWS/Lambda,FunctionName}",
            `MetricName="Errors" ${functionsNamed("jobs")}`,
            "Sum",
          ),
          new Metric({
            namespace: "Galena",
            metricName: "heartbeat_runs",
            label: "Heartbeat runs",
            statistic: "Sum",
            period: Duration.hours(1),
          }),
          untriggeredJobs.with({ label: "Jobs the API couldn't start" }),
        ]),
      ],
      [
        plot("API requests", [
          api.metricCount({ period, statistic: "Sum", label: "Requests" }),
          api.metricClientError({ period, statistic: "Sum", label: "4xx" }),
          api.metricServerError({ period, statistic: "Sum", label: "5xx" }),
          handler.metricErrors({ period, statistic: "Sum", label: "Handler errors" }),
        ]),
        plot("API latency (ms)", [
          api.metricLatency({ period, statistic: "p95", label: "API, p95" }),
          handler.metricDuration({ period, statistic: "p95", label: "Handler, p95" }),
        ]),
      ],
      [
        plot("Aurora capacity (ACU)", [
          new Metric({
            namespace: "AWS/RDS",
            metricName: "ServerlessDatabaseCapacity",
            dimensionsMap: { DBClusterIdentifier: Fn.select(6, Fn.split(":", clusterArn)) },
            statistic: "Maximum",
            label: "Capacity",
            period,
          }),
        ]),
      ],
    ],
  });
}
