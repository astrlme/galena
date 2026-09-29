import { Stack, type StackProps, Token, Validations } from "aws-cdk-lib";
import { PolicyStatement, User } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { pageBucketName } from "./status-page.ts";

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

    const pageBucket = `arn:${this.partition}:s3:::${pageBucketName(stage, this.account)}`;

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
      // page.publish and page.rebuild-html write the page's files and read snapshot.json back;
      // listing lets a missing file read as absent rather than forbidden.
      new PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [`${pageBucket}/pages/*`],
      }),
      new PolicyStatement({ actions: ["s3:ListBucket"], resources: [pageBucket] }),
    ]) {
      this.user.addToPolicy(statement);
    }
    const account = Token.isUnresolved(this.account) ? "<AWS::AccountId>" : this.account;
    for (const partition of ["aws", "<AWS::Partition>"]) {
      Validations.of(this.user).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:${partition}:s3:::${pageBucketName(stage, account)}/pages/*]`,
        reason:
          "The page's files are named by incident and build hash, so publishing writes any key under pages/.",
      });
    }
  }
}
