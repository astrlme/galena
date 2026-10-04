import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Annotations,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
  Token,
  Validations,
} from "aws-cdk-lib";
import type { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Function as CloudFrontFunction,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption, type CfnBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { ORIGIN_HEADER, originSecretName } from "./api.ts";

// The export writes /dashboard/ as dashboard/index.html; S3 behind OAC has no index documents.
export const indexRewrite = `function handler(event) {
  var request = event.request;
  if (request.uri.endsWith("/")) request.uri += "index.html";
  else if (request.uri.lastIndexOf(".") < request.uri.lastIndexOf("/")) request.uri += "/index.html";
  return request;
}`;

/**
 * The Next.js static export in S3 behind CloudFront. With `api` it is the dashboard: /auth/* and
 * /v1/* go to the HTTP API on the same origin, so cookies are first-party. Without it, it is a
 * plain site (the project's landing page and docs) that leaves out the dashboard and sign-in.
 */
export class WebStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: StageConfig;
      api?: HttpApi;
      /** The name it answers on, with `certificate` from a stack in us-east-1. */
      domain?: string;
      certificate?: ICertificate;
      /** The static export to upload; tests pass a fixture. */
      siteDir?: string;
    },
  ) {
    super(scope, id, props);
    const kind = props.api ? "dashboard" : "site";

    // Holds only the build output, which CI uploads again on every deploy.
    const site = new Bucket(this, "Site", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiBehaviors = props.api ? this.apiBehaviors(props.api, props.config.stage) : undefined;

    // Next's static export bootstraps with inline scripts, so scripts and styles allow
    // 'unsafe-inline'; everything else is this origin only, and nothing may frame the dashboard.
    const headers = new ResponseHeadersPolicy(this, "Headers", {
      comment: `Galena ${props.config.stage} ${kind}`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
          ].join("; "),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const domain = props.certificate ? props.domain : undefined;
    const distribution = new Distribution(this, "Distribution", {
      comment: `Galena ${props.config.stage} ${kind}`,
      ...(props.certificate && domain
        ? {
            domainNames: [domain],
            certificate: props.certificate,
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
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
      // The dashboard has no custom error pages: CloudFront applies them to every behaviour and
      // would turn the API's JSON 403 and 404 problems into HTML. The site has no API, and S3
      // answers 403 for a missing file.
      ...(apiBehaviors
        ? { additionalBehaviors: apiBehaviors }
        : {
            errorResponses: [403, 404].map((httpStatus) => ({
              httpStatus,
              responseHttpStatus: 404,
              responsePagePath: "/404.html",
            })),
          }),
    });

    for (const [id, reason] of [
      [
        "AwsSolutions-S1",
        "The bucket holds public build output that CI re-uploads; access logs would record nothing worth keeping.",
      ],
      [
        "AwsSolutions-CFR1",
        props.api
          ? "The dashboard is for the owner's team wherever they are; sign-in guards it, not geography."
          : "The site is public documentation for anyone, anywhere.",
      ],
      [
        "AwsSolutions-CFR2",
        props.api
          ? "WAF costs more than the monthly budget; the app authenticates every route and the HTTP API is throttled at 50 rps."
          : "The site is static files with no forms or sign-in; WAF costs more than the monthly budget.",
      ],
      [
        "AwsSolutions-CFR3",
        "Access logs would need a log bucket and hold visitor IPs; the API keeps its own access logs.",
      ],
      [
        "AwsSolutions-CFR4",
        "Without a custom domain the default CloudFront certificate cannot pin TLS 1.2; with one it does.",
      ],
    ] as const) {
      Validations.of(id === "AwsSolutions-S1" ? site : distribution).acknowledge({ id, reason });
    }

    const url = `https://${domain ?? distribution.distributionDomainName}`;
    // The API reads this at cold start: it is where people sign in and where cookies belong.
    if (props.api) {
      new StringParameter(this, "PublicUrl", {
        parameterName: `/galena/${props.config.stage}/public-url`,
        stringValue: url,
      });
    }

    // The static export, uploaded on every deploy with a cache invalidation. Synth without a
    // build (tests, a quick `infra:synth`) skips it rather than failing.
    const out = props.siteDir ?? fileURLToPath(new URL("../../apps/web/out", import.meta.url));
    if (existsSync(out)) {
      new BucketDeployment(this, "Upload", {
        sources: [Source.asset(out)],
        destinationBucket: site,
        // The site build still holds these pages; without an API they could only fail.
        ...(props.api ? {} : { exclude: ["dashboard/*", "sign-in/*"] }),
        distribution,
        distributionPaths: ["/*"],
        memoryLimit: 512,
      });
      acknowledgeBucketDeployment(this, site);
    } else {
      Annotations.of(this).addWarning(
        `${out} is missing, so the ${kind} is not uploaded. Build apps/web before deploying.`,
      );
    }

    new CfnOutput(this, props.api ? "DashboardUrl" : "SiteUrl", { value: url });
    // Where the domain's CNAME at the DNS host points.
    new CfnOutput(this, "DistributionDomain", { value: distribution.distributionDomainName });
    new CfnOutput(this, "SiteBucket", { value: site.bucketName });
  }

  /** /auth/* and /v1/* to the HTTP API, uncached, with the origin secret only CloudFront knows. */
  private apiBehaviors(httpApi: HttpApi, stage: string) {
    const origin = new HttpOrigin(Fn.select(2, Fn.split("/", httpApi.apiEndpoint)), {
      customHeaders: {
        [ORIGIN_HEADER]: SecretValue.secretsManager(originSecretName(stage)).unsafeUnwrap(),
      },
    });
    // What the API reads: cookies, the query and these headers. Host stays API Gateway's own;
    // CloudFront-Viewer-Address is the visitor's address, which the sign-in limits key on.
    const apiRequests = new OriginRequestPolicy(this, "ApiRequests", {
      comment: "Dashboard requests to the API",
      headerBehavior: OriginRequestHeaderBehavior.allowList(
        "CloudFront-Viewer-Address",
        "Origin",
        "Referer",
        "User-Agent",
        "Content-Type",
        "Accept",
      ),
      cookieBehavior: OriginRequestCookieBehavior.all(),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
    });
    const behavior = {
      origin,
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: apiRequests,
    };
    return { "/auth/*": behavior, "/v1/*": behavior };
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
