import { Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement, User } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

/**
 * The IAM user the trigger.dev workers act as. They run outside AWS, so they hold an access key
 * for it (created by hand, never in CloudFormation, and rotated quarterly). Each task that needs
 * more AWS access adds exactly that here.
 */
export class WorkerAccessStack extends Stack {
  readonly user: User;

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const { stage } = props.config;
    const param = (name: string) =>
      StringParameter.valueForStringParameter(this, `/galena/${stage}/${name}`);
    const clusterArn = param("database-cluster-arn");
    const configBucket = param("config-bucket");

    this.user = new User(this, "User", { userName: `galena-${stage}-worker-access` });
    for (const statement of [
      new PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ],
        resources: [clusterArn],
      }),
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [param("database-secret-arn")],
      }),
      // outbox.dispatch rebuilds monitors.json after every monitor change.
      new PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`arn:${this.partition}:s3:::${configBucket}/monitors.json`],
      }),
    ]) {
      this.user.addToPolicy(statement);
    }
  }
}
