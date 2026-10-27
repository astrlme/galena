import { CustomResource, Duration, Stack, Validations } from "aws-cdk-lib";
import { KeyGroup, PublicKey } from "aws-cdk-lib/aws-cloudfront";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  type CfnFunction,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

// Runs on deploy. The first time it makes an RSA key pair and keeps the private half in a
// SecureString; afterwards it derives the same public half from it, so a redeploy never changes
// the key CloudFront trusts (a CloudFront public key can't be updated in place).
const MAKER = `
const { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } = require("@aws-sdk/client-ssm");
const { createPublicKey, generateKeyPairSync } = require("node:crypto");
const ssm = new SSMClient({});
const missing = (error) => {
  if (error.name === "ParameterNotFound") return undefined;
  throw error;
};
exports.handler = async (event) => {
  const name = event.ResourceProperties.ParameterName;
  if (event.RequestType === "Delete") {
    await ssm.send(new DeleteParameterCommand({ Name: name })).catch(missing);
    return { PhysicalResourceId: name };
  }
  let privateKey = await ssm
    .send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    .then((r) => r.Parameter.Value, missing);
  if (!privateKey) {
    privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    await ssm.send(new PutParameterCommand({ Name: name, Value: privateKey, Type: "SecureString" }));
  }
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  return { PhysicalResourceId: name, Data: { PublicKey: publicKey } };
};
`;

/**
 * The key CloudFront trusts for the internal page. The API signs access cookies with its private
 * half, read at cold start from `parameterName`. Known limit: rotating it means a new construct
 * id here (CloudFront can't change a public key in place) and deleting the old parameter.
 */
export class PageKey extends Construct {
  readonly keyGroup: KeyGroup;
  readonly publicKeyId: string;
  readonly parameterName: string;

  constructor(scope: Construct, id: string, props: { stage: string }) {
    super(scope, id);
    const stack = Stack.of(this);
    this.parameterName = `/galena/${props.stage}/page-signing-key`;

    const logGroup = new LogGroup(this, "MakerLogs", { retention: RetentionDays.ONE_MONTH });
    const role = new Role(this, "MakerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [
          stack.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: this.parameterName.slice(1),
          }),
        ],
      }),
    );
    const maker = new LambdaFunction(this, "Maker", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromInline(MAKER),
      // RSA key generation is the slow part: a second or two at this size.
      memorySize: 512,
      timeout: Duration.minutes(1),
      role,
      logGroup,
    });
    const provider = new Provider(this, "Provider", {
      onEventHandler: maker,
      logGroup: new LogGroup(this, "ProviderLogs", { retention: RetentionDays.ONE_MONTH }),
    });
    // CDK's provider framework calls the maker; its role is CDK's own.
    const makerId = stack.resolve(stack.getLogicalId(maker.node.defaultChild as CfnFunction));
    for (const [findingId, reason] of [
      [
        "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
        "CDK's custom resource provider writes its logs through AWSLambdaBasicExecutionRole.",
      ],
      [
        `AwsSolutions-IAM5[Resource::<${makerId}.Arn>:*]`,
        "CDK's provider may invoke any version of the key maker, and only that function.",
      ],
    ]) {
      Validations.of(provider).acknowledge({ id: findingId as string, reason: reason as string });
    }
    const key = new CustomResource(this, "Key", {
      serviceToken: provider.serviceToken,
      properties: { ParameterName: this.parameterName },
    });

    const publicKey = new PublicKey(this, "PublicKey", {
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
