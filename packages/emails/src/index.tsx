import {
  noticeAffected as affected,
  type ComponentStatus,
  componentStatusLabels,
  componentStatusSymbols,
  EXPIRY_THRESHOLDS,
  type Expiry,
  expirySubjects,
  type MemberRole,
  memberRoleInvitations,
  type Notice,
  noticeAffectedLabel,
  noticeState,
  noticeParagraphs as paragraphs,
  noticeStatusLine as statusLine,
  noticeSubject as subject,
  utcDateTime,
} from "@galena/contracts";
import { light, stateTokens } from "@galena/ui/tokens";
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import { Fragment, type ReactNode } from "react";
import { footerText, linkText } from "./words.ts";

export type Email = { subject: string; html: string; text: string };
type Page = Notice["page"];

// Email clients ignore CSS variables and most web fonts: token hex values, inline, and the
// system font stack.
const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const text = { fontSize: "16px", lineHeight: "1.55", margin: "0 0 16px" };
const secondary = { ...text, fontSize: "14px", lineHeight: "1.45", color: light.slate };
const link = { color: light.ink, textDecoration: "underline" };
/** A state's light-mode colour (4.5:1 on white); information without a state stays grey. */
const stateColour = (state: ComponentStatus | null) =>
  state ? light[stateTokens[state]] : light.slate;
// The one primary action a view may have, inverted.
const button = {
  display: "inline-block",
  backgroundColor: light.ink,
  color: light.paper,
  padding: "10px 16px",
  borderRadius: "8px",
  fontWeight: 600,
  textDecoration: "none",
};

function Layout(props: { page: Page; preview: string; children: ReactNode; footer: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={{ backgroundColor: light.paper, color: light.ink, fontFamily: font, margin: 0 }}>
        <Container style={{ maxWidth: "600px", padding: "32px 24px" }}>
          {/* The page's own name heads the mail: subscribers hear from that page, not from Galena. */}
          <Text style={{ ...text, fontWeight: 600 }}>{props.page.name} status</Text>
          {props.children}
          <Hr style={{ borderColor: light.mist, margin: "32px 0 16px" }} />
          {props.footer}
        </Container>
      </Body>
    </Html>
  );
}

/** Double opt-in: nothing else is sent to the address until this link is followed. */
export async function confirmationEmail(input: { page: Page; confirmUrl: string }): Promise<Email> {
  const { page, confirmUrl } = input;
  const ask = `Confirm that you want email from ${page.name} status when an incident or maintenance is posted.`;
  const expiry =
    "The link works for 7 days. If you didn't ask for this, ignore this email: nothing is sent until you confirm.";
  const why = `Sent because this address was entered on ${page.url}.`;
  const html = await render(
    <Layout page={page} preview={ask} footer={<Text style={secondary}>{why}</Text>}>
      <Heading as="h1" style={{ fontSize: "24px", lineHeight: "1.25", margin: "24px 0 16px" }}>
        Confirm your subscription
      </Heading>
      <Text style={text}>{ask}</Text>
      <Text style={text}>
        <Link href={confirmUrl} style={button}>
          Confirm subscription
        </Link>
      </Text>
      <Text style={secondary}>{expiry}</Text>
    </Layout>,
  );
  return {
    subject: `Confirm your subscription to ${page.name} status`,
    html,
    text: [ask, `Confirm subscription: ${confirmUrl}`, expiry, "--", why].join("\n\n"),
  };
}

/** An incident or maintenance update, with one-click unsubscribe in the footer. */
export async function noticeEmail(
  notice: Notice,
  links: { unsubscribeUrl: string },
): Promise<Email> {
  const who = affected(notice);
  const html = await render(
    <Layout
      page={notice.page}
      preview={statusLine(notice)}
      footer={
        <Text style={secondary}>
          {footerText(notice)}{" "}
          <Link href={links.unsubscribeUrl} style={{ ...link, color: light.slate }}>
            Unsubscribe
          </Link>
        </Text>
      }
    >
      <Heading as="h1" style={{ fontSize: "24px", lineHeight: "1.25", margin: "24px 0 8px" }}>
        {notice.title}
      </Heading>
      <Text style={{ ...secondary, color: stateColour(noticeState(notice)), fontWeight: 600 }}>
        {statusLine(notice)}
      </Text>
      {who && (
        <Text style={text}>
          {noticeAffectedLabel(notice)}:{" "}
          {notice.components.map((c, i) => (
            <Fragment key={c.id}>
              {i > 0 && ", "}
              {c.name}
              {c.status && (
                <>
                  {" ("}
                  <span style={{ color: stateColour(c.status) }}>
                    {componentStatusSymbols[c.status]} {componentStatusLabels[c.status]}
                  </span>
                  {")"}
                </>
              )}
            </Fragment>
          ))}
        </Text>
      )}
      {paragraphs(notice).map((p) => (
        <Text key={p} style={text}>
          {p}
        </Text>
      ))}
      <Text style={text}>
        <Link href={notice.url} style={link}>
          {linkText(notice)}
        </Link>
      </Text>
    </Layout>,
  );
  const plain = [
    notice.title,
    statusLine(notice),
    ...(who ? [who] : []),
    ...paragraphs(notice),
    `${linkText(notice)}: ${notice.url}`,
    "--",
    `${footerText(notice)} Unsubscribe: ${links.unsubscribeUrl}`,
  ];
  return { subject: subject(notice), html, text: plain.join("\n\n") };
}

/** What a member is warned about: one certificate or domain, its expiry date known. */
export type ExpiryWarning = Pick<Expiry, "kind" | "name" | "issuer"> & {
  expiresAt: string;
  daysLeft: number;
};

/** A warning to a member, never a subscriber, that a certificate or domain expires soon. */
export async function expiryEmail(
  warning: ExpiryWarning,
  links: { page: Page; dashboardUrl: string },
): Promise<Email> {
  const { kind, name, issuer, expiresAt, daysLeft } = warning;
  const what = expirySubjects[kind](name);
  const title = `${what} expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;
  const when =
    kind === "certificate"
      ? `The TLS certificate for ${name} expires on ${utcDateTime(expiresAt)}.${issuer ? ` ${issuer} issued it.` : ""}`
      : `The domain ${name} expires on ${utcDateTime(expiresAt)}, according to its registry.`;
  const act =
    kind === "certificate"
      ? "Renew it, or check that automatic renewal works, before then. Once it expires, browsers refuse the site and the monitors that reach it go down."
      : "Renew it with your registrar before then. Once a domain lapses, its websites and email stop working.";
  const days = `${EXPIRY_THRESHOLDS.slice(0, -1).join(", ")} and ${EXPIRY_THRESHOLDS.at(-1)}`;
  const why = `You get this email because you're a member of the ${links.page.name} dashboard. Warnings go out ${days} days before an expiry.`;
  const linkLabel = "See it in the dashboard";
  const html = await render(
    <Layout page={links.page} preview={when} footer={<Text style={secondary}>{why}</Text>}>
      <Heading as="h1" style={{ fontSize: "24px", lineHeight: "1.25", margin: "24px 0 16px" }}>
        {title}
      </Heading>
      <Text style={text}>{when}</Text>
      <Text style={text}>{act}</Text>
      <Text style={text}>
        <Link href={links.dashboardUrl} style={link}>
          {linkLabel}
        </Link>
      </Text>
    </Layout>,
  );
  return {
    subject: title,
    html,
    text: [when, act, `${linkLabel}: ${links.dashboardUrl}`, "--", why].join("\n\n"),
  };
}

export type Invitation = {
  workspaceName: string;
  /** Null once whoever sent it has left. */
  inviterName: string | null;
  email: string;
  role: MemberRole;
  expiresAt: string;
  link: string;
};

/** An invite to join a workspace's dashboard: the link works once, for this address only. */
export async function inviteEmail(invite: Invitation, page: Page): Promise<Email> {
  const by = invite.inviterName ?? "Someone";
  const title = `${by} invited you to the ${invite.workspaceName} dashboard`;
  const what = memberRoleInvitations[invite.role];
  const when = `The link works once, for ${invite.email}, until ${utcDateTime(invite.expiresAt)}.`;
  const why = `You get this email because someone invited ${invite.email} to the ${invite.workspaceName} dashboard. If you didn't expect it, ignore it: nothing happens unless the link is used.`;
  const linkLabel = "Accept invite";
  const html = await render(
    <Layout page={page} preview={what} footer={<Text style={secondary}>{why}</Text>}>
      <Heading as="h1" style={{ fontSize: "24px", lineHeight: "1.25", margin: "24px 0 16px" }}>
        {title}
      </Heading>
      <Text style={text}>{what}</Text>
      <Text style={text}>{when}</Text>
      <Text style={text}>
        <Link href={invite.link} style={link}>
          {linkLabel}
        </Link>
      </Text>
    </Layout>,
  );
  return {
    subject: title,
    html,
    text: [what, when, `${linkLabel}: ${invite.link}`, "--", why].join("\n\n"),
  };
}
