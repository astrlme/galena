import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
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
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
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
    props: StackProps & { config: StageConfig; api: HttpApi },
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

    new CfnOutput(this, "DashboardUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "SiteBucket", { value: site.bucketName });
  }
}
