import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import {
  ConfigurationSet,
  DkimIdentity,
  EasyDkimSigningKeyLength,
  EmailIdentity,
  Identity,
  MailFromBehaviorOnMxFailure,
  SuppressionReasons,
} from "aws-cdk-lib/aws-ses";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

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
