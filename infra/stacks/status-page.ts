import {
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
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from "aws-cdk-lib/aws-certificatemanager";
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
import { HttpOrigin, OriginGroup, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  type CfnBucket,
  type IBucket,
} from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { ORIGIN_HEADER, originSecretName } from "./api.ts";
import { indexRewrite } from "./web.ts";

// The page the workers publish: `ensurePage` creates it with this slug.
const PAGE_SLUG = "status";

/**
 * Answers a CORS preflight for the Statuspage files at the edge, as Statuspage does: S3 has no
 * CORS rules to answer it, and a widget that sends `If-None-Match` asks first.
 */
export const corsPreflight = `function handler(event) {
  var request = event.request;
  if (request.method !== "OPTIONS") return request;
  var headers = {
    "access-control-allow-origin": { value: "*" },
    "access-control-allow-methods": { value: "GET, HEAD" },
    "access-control-max-age": { value: "86400" }
  };
  var asked = request.headers["access-control-request-headers"];
  if (asked) headers["access-control-allow-headers"] = { value: asked.value };
  return { statusCode: 204, statusDescription: "No Content", headers: headers };
}`;

/** Bucket names are fixed so the stacks in each region, and the workers, can name them. */
export const pageBucketName = (stage: string, account: string, replica = false) =>
  `galena-${stage}-page${replica ? "-replica" : ""}-${account}`;

const pageBucket = (scope: Construct, name: string, replicateTo?: IBucket) =>
  new Bucket(scope, "Bucket", {
    bucketName: name,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    // Replication needs versioning; every publish overwrites the same keys, so old versions go.
    versioned: true,
    lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(1) }],
    ...(replicateTo ? { replicationRules: [{ destination: replicateTo, priority: 1 }] } : {}),
    // The page is rebuilt from the database on the next publish.
    removalPolicy: RemovalPolicy.DESTROY,
  });

/** The replica the distribution fails over to, in another region than the primary. */
export class PageReplicaStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const bucket = pageBucket(this, pageBucketName(props.config.stage, this.account, true));
    // The distribution lives in the primary's stack; naming it here would make the two stacks
    // depend on each other, so any distribution of this account may read.
    bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [bucket.arnForObjects("*")],
        conditions: {
          StringLike: {
            "AWS:SourceArn": `arn:${this.partition}:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );
    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "The bucket holds a copy of public page files; access logs would record nothing worth keeping.",
    });
  }
}

/** CloudFront takes certificates only from us-east-1. Validated by a CNAME at the DNS host. */
export class CertificateStack extends Stack {
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: StackProps & { domain: string }) {
    super(scope, id, props);
    this.certificate = new Certificate(this, "Certificate", {
      domainName: props.domain,
      validation: CertificateValidation.fromDns(),
    });
  }
}

/**
 * The public status page: S3 in the primary page region, replicated to the replica region, behind
 * CloudFront, which fails over to the replica when the primary answers 403 or 5xx. Nothing here
 * calls the API or the database; only the subscription forms under /public/* go to the API.
 */
export class StatusPageStack extends Stack {
  /** Where readers find the page: its domain, or the distribution's own. */
  readonly url: string;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: StageConfig;
      certificate?: ICertificate;
      /** The HTTP API's endpoint (https://…): the subscription forms post to it. */
      apiEndpoint: string;
    },
  ) {
    super(scope, id, props);
    const { config, certificate } = props;
    const replica = Bucket.fromBucketAttributes(this, "Replica", {
      bucketName: pageBucketName(config.stage, this.account, true),
      region: config.pageRegions.replica,
    });
    const primary = pageBucket(this, pageBucketName(config.stage, this.account), replica);

    const origin = (bucket: IBucket) =>
      S3BucketOrigin.withOriginAccessControl(bucket, { originPath: `/pages/${PAGE_SLUG}` });
    const securityHeadersBehavior = {
      // Scripts and styles are pinned by hash in the page's own CSP; what a meta tag can't
      // say goes here.
      contentSecurityPolicy: {
        contentSecurityPolicy:
          "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
        override: true,
      },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(365),
        includeSubdomains: false,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
      referrerPolicy: {
        referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
    };
    const headers = new ResponseHeadersPolicy(this, "Headers", { securityHeadersBehavior });
    // Statuspage's files are read by widgets on other sites, as Statuspage's own are: public
    // data, no cookies, so any origin may read them.
    const statuspageHeaders = new ResponseHeadersPolicy(this, "StatuspageHeaders", {
      securityHeadersBehavior,
      corsBehavior: {
        accessControlAllowOrigins: ["*"],
        accessControlAllowMethods: ["GET", "HEAD"],
        accessControlAllowHeaders: ["*"],
        accessControlExposeHeaders: ["ETag"],
        accessControlAllowCredentials: false,
        originOverride: true,
      },
    });
    // The subscription forms, on the page's own origin so they need no CORS. Only what the API
    // uses crosses: the visitor's address for the per-network limit, the form's type, the query.
    const forms = new OriginRequestPolicy(this, "Forms", {
      comment: "Status page subscription forms",
      headerBehavior: OriginRequestHeaderBehavior.allowList(
        "CloudFront-Viewer-Address",
        "Content-Type",
        "Accept",
      ),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
      cookieBehavior: OriginRequestCookieBehavior.none(),
    });
    const pageFiles = new OriginGroup({
      primaryOrigin: origin(primary),
      fallbackOrigin: origin(replica),
      // S3 behind OAC answers 403 for a missing object.
      fallbackStatusCodes: [403, 500, 502, 503, 504],
    });
    const distribution = new Distribution(this, "Distribution", {
      comment: `Galena ${config.stage} status page`,
      ...(certificate && config.pageDomain
        ? {
            domainNames: [config.pageDomain],
            certificate,
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      defaultBehavior: {
        origin: pageFiles,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Honours each file's Cache-Control and compresses.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
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
      additionalBehaviors: {
        "/api/v2/*": {
          origin: pageFiles,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: statuspageHeaders,
          functionAssociations: [
            {
              eventType: FunctionEventType.VIEWER_REQUEST,
              function: new CloudFrontFunction(this, "CorsPreflight", {
                code: FunctionCode.fromInline(corsPreflight),
                runtime: FunctionRuntime.JS_2_0,
              }),
            },
          ],
        },
        "/public/*": {
          origin: new HttpOrigin(Fn.select(2, Fn.split("/", props.apiEndpoint)), {
            // From the secret's copy in this region.
            customHeaders: {
              [ORIGIN_HEADER]: SecretValue.secretsManager(
                originSecretName(config.stage),
              ).unsafeUnwrap(),
            },
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: forms,
          responseHeadersPolicy: headers,
        },
      },
    });

    for (const [id, reason] of [
      [
        "AwsSolutions-CFR1",
        "A status page is for everyone who uses the service, wherever they are.",
      ],
      ["AwsSolutions-CFR2", "WAF costs more than the monthly budget; the page is static files."],
      [
        "AwsSolutions-CFR3",
        "Access logs would need a log bucket and hold visitor IPs; the page has no private data.",
      ],
      ...(certificate
        ? []
        : [
            [
              "AwsSolutions-CFR4",
              "Without a custom domain the default certificate cannot pin TLS 1.2.",
            ],
          ]),
    ] as const) {
      Validations.of(distribution).acknowledge({ id, reason });
    }
    // Replication reads every object of the primary and writes every object of the replica.
    const account = Token.isUnresolved(this.account) ? "<AWS::AccountId>" : this.account;
    const replicaName = pageBucketName(config.stage, account, true);
    const primaryId = this.resolve(this.getLogicalId(primary.node.defaultChild as CfnBucket));
    for (const resource of [
      `<${primaryId}.Arn>/*`,
      ...["aws", "<AWS::Partition>"].map((p) => `arn:${p}:s3:::${replicaName}/*`),
    ]) {
      Validations.of(primary).acknowledge({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          "S3 replication copies every object, so its role acts on all objects of both page buckets.",
      });
    }
    Validations.of(distribution).acknowledge({
      id: "Annotation::@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac",
      reason: "The replica's own stack grants this account's distributions read access.",
    });
    Validations.of(primary).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "The bucket holds public page files the workers rewrite; access logs would record nothing worth keeping.",
    });

    this.url = `https://${config.pageDomain ?? distribution.distributionDomainName}`;

    new CfnOutput(this, "PageBucket", { value: primary.bucketName });
    new CfnOutput(this, "DistributionDomain", { value: distribution.distributionDomainName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
  }
}
