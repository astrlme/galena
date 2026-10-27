import { CustomResource, Duration, Stack, Validations } from "aws-cdk-lib";
import { KeyGroup, PublicKey } from "aws-cdk-lib/aws-cloudfront";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, type CfnFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { bundling, source } from "./bundling.ts";

/**
 * The key CloudFront trusts for the internal page, made on the first deploy by
 * `apps/api/src/page-key-maker.ts`. The API signs access cookies with its private half, read at
 * cold start from `parameterName`. A new `generation` rotates it: a new key under a new name, and
 * members open the page again from the dashboard. Known limit: deleting the stack, or rotating,
 * leaves the old parameter behind; delete it by hand.
 */
export class PageKey extends Construct {
  readonly keyGroup: KeyGroup;
  readonly publicKeyId: string;
  readonly parameterName: string;

  constructor(scope: Construct, id: string, props: { stage: string; generation: number }) {
    super(scope, id);
    const stack = Stack.of(this);
    const { generation } = props;
    this.parameterName = `/galena/${props.stage}/page-signing-key-${generation}`;

    const logGroup = new LogGroup(this, "MakerLogs", { retention: RetentionDays.ONE_MONTH });
    const role = new Role(this, "MakerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          stack.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: this.parameterName.slice(1),
          }),
        ],
      }),
    );
    const maker = new NodejsFunction(this, "Maker", {
      entry: source("apps/api/src/page-key-maker.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      // RSA key generation is the slow part: a second or two at this size.
      memorySize: 512,
      timeout: Duration.minutes(1),
      role,
      logGroup,
      bundling,
    });
    const provider = new Provider(this, "Provider", {
      onEventHandler: maker,
      logGroup: new LogGroup(this, "ProviderLogs", { retention: RetentionDays.ONE_MONTH }),
    });
    // CDK's provider framework calls the maker; its role is CDK's own.
    const makerId = stack.resolve(stack.getLogicalId(maker.node.defaultChild as CfnFunction));
    const findings: [string, string][] = [
      [
        "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
        "CDK's custom resource provider writes its logs through AWSLambdaBasicExecutionRole.",
      ],
      [
        `AwsSolutions-IAM5[Resource::<${makerId}.Arn>:*]`,
        "CDK's provider may invoke any version of the key maker, and only that function.",
      ],
    ];
    for (const [findingId, reason] of findings) {
      Validations.of(provider).acknowledge({ id: findingId, reason });
    }
    // Each generation is a new resource and a new public key; the key group stays, so the
    // dashboard's distribution keeps the same reference.
    const key = new CustomResource(this, `Key${generation}`, {
      serviceToken: provider.serviceToken,
      properties: { ParameterName: this.parameterName },
    });

    const publicKey = new PublicKey(this, `PublicKey${generation}`, {
      encodedKey: key.getAttString("PublicKey"),
      comment: `Galena ${props.stage} internal page`,
    });
    this.publicKeyId = publicKey.publicKeyId;
    this.keyGroup = new KeyGroup(this, "KeyGroup", {
      items: [publicKey],
      comment: `Galena ${props.stage} internal page`,
    });
  }
}
