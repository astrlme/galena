import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

/**
 * What a Lambda needs to reach Aurora through the Data API: the environment it reads and a role
 * that can use the cluster, read its secret and write its own logs, nothing more. Foundation
 * publishes the ARNs in SSM, which keeps the stacks free of CloudFormation exports.
 */
export function dataApiAccess(scope: Construct, stage: string) {
  const clusterArn = StringParameter.valueForStringParameter(
    scope,
    `/galena/${stage}/database-cluster-arn`,
  );
  const secretArn = StringParameter.valueForStringParameter(
    scope,
    `/galena/${stage}/database-secret-arn`,
  );
  const statements = [
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
    new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [secretArn] }),
  ];
  return {
    environment: {
      GLN_DB_CLUSTER_ARN: clusterArn,
      GLN_DB_SECRET_ARN: secretArn,
      GLN_DB_NAME: "galena",
    },
    /** Its own role instead of AWSLambdaBasicExecutionRole. */
    role: (id: string, logGroup: LogGroup) => {
      const role = new Role(scope, id, { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
      logGroup.grantWrite(role);
      for (const statement of statements) role.addToPolicy(statement);
      return role;
    },
  };
}
