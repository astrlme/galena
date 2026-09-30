import { CfnOutput, Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  ConfigurationSet,
  DkimIdentity,
  EasyDkimSigningKeyLength,
  EmailIdentity,
  EmailSendingEvent,
  EventDestination,
  Identity,
  MailFromBehaviorOnMxFailure,
  SuppressionReasons,
} from "aws-cdk-lib/aws-ses";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";
import { dataApiAccess } from "./data-api.ts";

/**
 * The SES identity notification email is sent from. DNS lives at Cloudflare, so the records it
 * needs are outputs for a person to add there: three DKIM CNAMEs, the MAIL FROM MX and SPF, and
 * DMARC. SES keeps an account sandbox until production access is granted by AWS.
 */
export class EmailStack extends Stack {
  readonly configurationSet: ConfigurationSet;
  readonly identity: EmailIdentity;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { config: StageConfig & { email: NonNullable<StageConfig["email"]> } },
  ) {
    super(scope, id, props);
    const { stage, email } = props.config;
    const mailFrom = `bounce.${email.domain}`;

    this.configurationSet = new ConfigurationSet(this, "ConfigurationSet", {
      configurationSetName: `galena-${stage}`,
      // SES stops sending to an address that bounced hard or complained.
      suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      reputationMetrics: true,
    });
    this.identity = new EmailIdentity(this, "Identity", {
      identity: Identity.domain(email.domain),
      configurationSet: this.configurationSet,
      dkimSigning: true,
      dkimIdentity: DkimIdentity.easyDkim(EasyDkimSigningKeyLength.RSA_2048_BIT),
      // Bounces go to our own subdomain, so SPF aligns with the From domain. Should its MX go
      // missing, SES falls back to its own MAIL FROM and DKIM alone still passes DMARC.
      mailFromDomain: mailFrom,
      mailFromBehaviorOnMxFailure: MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });

    // Bounces and complaints: SES → SNS → a small Lambda that suppresses the address.
    const feedback = new Topic(this, "Feedback", { enforceSSL: true });
    this.configurationSet.addEventDestination("Feedback", {
      destination: EventDestination.snsTopic(feedback),
      events: [EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT],
    });
    const access = dataApiAccess(this, stage);
    const logs = new LogGroup(this, "FeedbackLogs", { retention: RetentionDays.ONE_MONTH });
    const handler = new NodejsFunction(this, "FeedbackHandler", {
      entry: source("apps/api/src/ses-feedback.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // The first statement after Aurora pauses waits ~15 s for it to resume.
      timeout: Duration.seconds(60),
      role: access.role("FeedbackRole", logs),
      logGroup: logs,
      environment: { GLN_STAGE: stage, ...access.environment },
      bundling,
    });
    feedback.addSubscription(new LambdaSubscription(handler));
    Validations.of(feedback).acknowledge({
      id: "AwsSolutions-SNS2",
      reason:
        "SES can publish only to topics under a customer-managed key, which costs more than this budget; each message lives seconds, in transit over TLS only.",
    });

    this.identity.dkimRecords.forEach((record, i) => {
      new CfnOutput(this, `DkimCname${i + 1}`, {
        description: "CNAME at the DNS host (DNS only)",
        value: `${record.name} -> ${record.value}`,
      });
    });
    new CfnOutput(this, "MailFromMx", {
      description: "MX at the DNS host",
      value: `${mailFrom} -> 10 feedback-smtp.${this.region}.amazonses.com`,
    });
    new CfnOutput(this, "MailFromSpf", {
      description: "TXT at the DNS host",
      value: `${mailFrom} -> "v=spf1 include:amazonses.com ~all"`,
    });
    new CfnOutput(this, "Dmarc", {
      description: "TXT at the DNS host; tighten p= once reports look clean",
      value: `_dmarc.${email.domain} -> "v=DMARC1; p=none"`,
    });
    new CfnOutput(this, "From", { value: email.from });
    new CfnOutput(this, "ConfigurationSetName", {
      value: this.configurationSet.configurationSetName,
    });
  }
}
