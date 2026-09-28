import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Annotations,
  CfnOutput,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Token,
  Validations,
} from "aws-cdk-lib";
import type { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import {
  AllowedMethods,
  CachePolicy,
  Function as CloudFrontFunction,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  OriginRequestPolicy,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption, type CfnBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

// The export writes /dashboard/ as dashboard/index.html; S3 behind OAC has no index documents.
export const indexRewrite = `function handler(event) {
  var request = event.request;
  if (request.uri.endsWith("/")) request.uri += "index.html";
  else if (request.uri.lastIndexOf(".") < request.uri.lastIndexOf("/")) request.uri += "/index.html";
  return request;
}`;

/**
 * The dashboard and landing page: the Next.js static export in S3 behind CloudFront,
 * with /auth/* and /v1/* forwarded to the HTTP API on the same origin, so cookies are first-party.
 */
export class WebStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: StageConfig;
      api: HttpApi;
      /** The static export to upload; tests pass a fixture. */
      siteDir?: string;
    },
  ) {
    super(scope, id, props);

    // Holds only the build output, which CI uploads again on every deploy.
    const site = new Bucket(this, "Site", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new HttpOrigin(Fn.select(2, Fn.split("/", props.api.apiEndpoint)));
    const apiBehavior = {
      origin: api,
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      // Everything but Host, so API Gateway sees its own name and the app sees the cookies.
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    // No custom error pages: CloudFront applies them to every behaviour and would turn the API's
    // JSON 403 and 404 problems into HTML.
    const distribution = new Distribution(this, "Distribution", {
      comment: `Galena ${props.config.stage} dashboard`,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            eventType: FunctionEventType.VIEWER_REQUEST,
            function: new CloudFrontFunction(this, "IndexRewrite", {
              code: FunctionCode.fromInline(indexRewrite),
              runtime: FunctionRuntime.JS_2_0,
            }),
          },
        ],
      },
      additionalBehaviors: { "/auth/*": apiBehavior, "/v1/*": apiBehavior },
    });

    for (const [id, reason] of [
      [
        "AwsSolutions-S1",
        "The bucket holds public build output that CI re-uploads; access logs would record nothing worth keeping.",
      ],
      [
        "AwsSolutions-CFR1",
        "The dashboard is for the owner's team wherever they are; sign-in guards it, not geography.",
      ],
      [
        "AwsSolutions-CFR2",
        "WAF costs more than the monthly budget; the app authenticates every route and the HTTP API is throttled at 50 rps.",
      ],
      [
        "AwsSolutions-CFR3",
        "Access logs would need a log bucket and hold visitor IPs; the API keeps its own access logs.",
      ],
      [
        "AwsSolutions-CFR4",
        "The default CloudFront certificate cannot pin TLS 1.2; a custom domain does.",
      ],
    ] as const) {
      Validations.of(id === "AwsSolutions-S1" ? site : distribution).acknowledge({ id, reason });
    }

    const dashboardUrl = `https://${distribution.distributionDomainName}`;
    // The API reads this at cold start: it is where people sign in and where cookies belong.
    new StringParameter(this, "PublicUrl", {
      parameterName: `/galena/${props.config.stage}/public-url`,
      stringValue: dashboardUrl,
    });

    // The static export, uploaded on every deploy with a cache invalidation. Synth without a
    // build (tests, a quick `infra:synth`) skips it rather than failing.
    const out = props.siteDir ?? fileURLToPath(new URL("../../apps/web/out", import.meta.url));
    if (existsSync(out)) {
      new BucketDeployment(this, "Upload", {
        sources: [Source.asset(out)],
        destinationBucket: site,
        distribution,
        distributionPaths: ["/*"],
        memoryLimit: 512,
      });
      acknowledgeBucketDeployment(this, site);
    } else {
      Annotations.of(this).addWarning(
        "apps/web/out is missing, so the dashboard is not uploaded. Run `pnpm --filter @galena/web build` before deploying.",
      );
    }

    new CfnOutput(this, "DashboardUrl", { value: dashboardUrl });
    new CfnOutput(this, "SiteBucket", { value: site.bucketName });
  }
}

/**
 * CDK's BucketDeployment brings its own singleton Lambda (with the AWS CLI layer) that we don't
 * control. cdk-nag's IAM rules are granular, so each finding is acknowledged by its exact id; the
 * asset-bucket id is spelled with and without a resolved partition, as synth and tests differ.
 */
function acknowledgeBucketDeployment(stack: Stack, site: Bucket) {
  const copier = stack.node.children.find((c) =>
    c.node.id.startsWith("Custom::CDKBucketDeployment"),
  );
  if (!copier) return;
  const account = Token.isUnresolved(stack.account) ? "<AWS::AccountId>" : stack.account;
  const region = Token.isUnresolved(stack.region) ? "<AWS::Region>" : stack.region;
  const siteId = stack.resolve(stack.getLogicalId(site.node.defaultChild as CfnBucket));
  const copies =
    "It copies every file of the export into the site bucket and deletes stale ones, so its S3 actions and object paths are wildcards scoped to the CDK assets bucket and the site bucket.";
  const findings: [string, string][] = [
    [
      "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
      "CDK's BucketDeployment handler writes its logs through AWSLambdaBasicExecutionRole.",
    ],
    ...["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:Abort*"].map(
      (action): [string, string] => [`AwsSolutions-IAM5[Action::${action}]`, copies],
    ),
    [`AwsSolutions-IAM5[Resource::<${siteId}.Arn>/*]`, copies],
    ...["<AWS::Partition>", "aws"].map((partition): [string, string] => [
      `AwsSolutions-IAM5[Resource::arn:${partition}:s3:::cdk-hnb659fds-assets-${account}-${region}/*]`,
      copies,
    ]),
    [
      "AwsSolutions-IAM5[Resource::*]",
      "CloudFront invalidations cannot be scoped to one distribution in IAM.",
    ],
    [
      "AwsSolutions-L1",
      "CDK pins the BucketDeployment handler's runtime; it moves with aws-cdk-lib upgrades.",
    ],
  ];
  for (const [id, reason] of findings) Validations.of(copier).acknowledge({ id, reason });
}
