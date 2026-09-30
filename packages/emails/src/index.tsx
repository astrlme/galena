import {
  noticeAffected as affected,
  type Notice,
  noticeParagraphs as paragraphs,
  noticeStatusLine as statusLine,
  noticeSubject as subject,
} from "@galena/contracts";
import { light } from "@galena/ui/tokens";
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
import type { ReactNode } from "react";
import { footerText, linkText } from "./words.ts";

export type Email = { subject: string; html: string; text: string };
type Page = Notice["page"];

// Email clients ignore CSS variables and most web fonts: token hex values, inline, and the
// system font stack.
const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const text = { fontSize: "16px", lineHeight: "1.55", margin: "0 0 16px" };
const secondary = { ...text, fontSize: "14px", lineHeight: "1.45", color: light.slate };
const link = { color: light.ink, textDecoration: "underline" };
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
      <Text style={secondary}>{statusLine(notice)}</Text>
      {who && <Text style={text}>{who}</Text>}
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
