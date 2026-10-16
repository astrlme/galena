import { type Stack, Token, Validations } from "aws-cdk-lib";
import { type IRole, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { jobScheduleGroup } from "./foundation.ts";

/**
 * What a Lambda needs to start background jobs: the environment the SQS engine reads, and the
 * grants to send to the queues and schedule a job for later. Foundation publishes the queues in
 * SSM, which keeps the stacks free of CloudFormation exports.
 */
export function jobAccess(scope: Stack, stage: string) {
  const param = (name: string) =>
    StringParameter.valueForStringParameter(scope, `/galena/${stage}/${name}`);
  const jobs = param("jobs-queue-arn");
  const builds = param("builds-queue-arn");
  const group = jobScheduleGroup(stage);
  const schedulerRole = param("job-scheduler-role-arn");

  return {
    environment: {
      GLN_JOBS_QUEUE_URL: param("jobs-queue-url"),
      GLN_JOBS_QUEUE_ARN: jobs,
      GLN_BUILDS_QUEUE_URL: param("builds-queue-url"),
      GLN_BUILDS_QUEUE_ARN: builds,
      GLN_SCHEDULE_GROUP: group,
      GLN_SCHEDULER_ROLE_ARN: schedulerRole,
      GLN_SCHEDULE_DEAD_LETTER_ARN: param("schedule-dead-letter-arn"),
    },
    /**
     * Lets `role` send jobs to the jobs queue, and the HTML build to its own with `builds`; with
     * `schedule`, create one-time schedules in the deployment's group, handing them Scheduler's
     * role.
     */
    grant(role: IRole, { builds: sendsBuilds = false, schedule = false } = {}) {
      role.addToPrincipalPolicy(
        new PolicyStatement({
          actions: ["sqs:SendMessage"],
          resources: sendsBuilds ? [jobs, builds] : [jobs],
        }),
      );
      if (!schedule) return;
      role.addToPrincipalPolicy(
        new PolicyStatement({
          actions: ["scheduler:CreateSchedule"],
          resources: [
            scope.formatArn({
              service: "scheduler",
              resource: "schedule",
              resourceName: `${group}/*`,
            }),
          ],
        }),
      );
      role.addToPrincipalPolicy(
        new PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [schedulerRole],
          conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
        }),
      );
      // cdk-nag names a wildcard by its resource as synthesised: tokens become placeholders.
      const asNagShows = (value: string, placeholder: string) =>
        Token.isUnresolved(value) ? placeholder : value;
      const account = asNagShows(scope.account, "<AWS::AccountId>");
      const region = asNagShows(scope.region, "<AWS::Region>");
      for (const partition of ["aws", "<AWS::Partition>"]) {
        Validations.of(role).acknowledge({
          id: `AwsSolutions-IAM5[Resource::arn:${partition}:scheduler:${region}:${account}:schedule/${group}/*]`,
          reason:
            "Schedules are named by the hash of each job's key, so a job for later may be any schedule in the deployment's own group.",
        });
      }
    },
  };
}
