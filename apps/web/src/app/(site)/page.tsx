import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "../../components/button.tsx";
import { Diagram } from "../../components/diagram.tsx";
import { PagePreview } from "../../components/landing/page-preview.tsx";
import { baseOptions } from "../../lib/layout.shared.tsx";

// The project's own site builds with GLN_SITE=project and gets this landing page. Every other
// deployment's address opens its dashboard.
const project = process.env.GLN_SITE === "project";

const pitch =
  "Galena checks your services every minute from three AWS regions, decides when something is " +
  "really down, and publishes a static status page from regions of its own.";

export const metadata: Metadata = project
  ? {
      metadataBase: new URL("https://galena.astrl.me"),
      title: "Galena: a status page that stays up",
      description: pitch,
      openGraph: { title: "Galena", description: pitch, images: ["/social-card.png"] },
      twitter: { card: "summary_large_image", images: ["/social-card.png"] },
    }
  : { title: "Galena" };

const features = [
  {
    title: "Decides before it tells",
    body: "A monitor is down only when two of three regions agree, never on one failed check. A region whose own network breaks leaves the vote, and a monitor that keeps flipping holds still.",
    href: "/docs/concepts/detection/",
  },
  {
    title: "Stays up on its own",
    body: "The page is static files in two regions of its own. Visitors never reach the API or the database, so the page keeps serving when they are down.",
    href: "/docs/architecture/publishing/",
  },
  {
    title: "Tells the right people",
    body: "Email with double opt-in and one-click unsubscribe, Slack, and signed webhooks, each following only the components it cares about.",
    href: "/docs/concepts/notifications/",
  },
  {
    title: "Runs in your AWS account",
    body: "Deployed with the CDK from a GitHub workflow, with no NAT gateway and nothing polling the database.",
    href: "/docs/getting-started/self-hosting/",
  },
];

export default function Home() {
  if (!project) {
    return (
      <main className="mx-auto max-w-[720px] px-4 py-12">
        <meta httpEquiv="refresh" content="0; url=/dashboard/" />
        <p>
          Opening the{" "}
          <a href="/dashboard/" className="underline">
            dashboard
          </a>
          .
        </p>
      </main>
    );
  }
  return (
    <HomeLayout
      {...baseOptions()}
      links={[{ text: "Docs", url: "/docs/" }, ...(baseOptions().links ?? [])]}
    >
      <main className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
        <section className="grid items-center gap-12 py-16 md:grid-cols-[1.05fr_1fr] md:py-24">
          <div>
            <p className="font-mono text-[13px] text-slate">Open source, Apache-2.0</p>
            <h1 className="mt-4 text-[36px] font-[650] leading-[1.1] tracking-[-0.01em] sm:text-[48px]">
              A status page that stays up when everything else is down
            </h1>
            <p className="mt-5 max-w-[56ch] text-[17px] leading-[1.6] text-slate">{pitch}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/docs/getting-started/self-hosting/" variant="primary">
                Deploy to AWS
              </ButtonLink>
              <ButtonLink href="/docs/">Read the docs</ButtonLink>
              <ButtonLink href="https://github.com/astrlme/galena" variant="quiet">
                GitHub
              </ButtonLink>
            </div>
          </div>
          <PagePreview />
        </section>

        <section aria-labelledby="how" className="border-t border-mist py-16">
          <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
            <h2 id="how" className="text-[26px] font-[650] leading-tight">
              Three paths that fail on their own
            </h2>
            <div>
              <p className="text-[16px] leading-[1.6] text-slate">
                Checks never touch the database, people's changes never wait on checks, and visitors
                only ever load files. Any one of them can be down while the others carry on.
              </p>
              <p className="mt-4">
                <Link href="/docs/architecture/overview/" className="underline">
                  How it fits together
                </Link>
              </p>
            </div>
          </div>
          <div className="mx-auto mt-8 max-w-[760px]">
            <Diagram name="overview" />
          </div>
        </section>

        <section aria-labelledby="signal" className="border-t border-mist py-16">
          <h2 id="signal" className="text-[26px] font-[650] leading-tight">
            Picks the signal out of the noise
          </h2>
          <dl className="mt-8 grid gap-x-12 md:grid-cols-2">
            {features.map((f) => (
              <div key={f.title} className="border-t border-mist py-6">
                <dt className="text-[17px] font-semibold">
                  <Link href={f.href} className="hover:underline">
                    {f.title}
                  </Link>
                </dt>
                <dd className="mt-2 text-[16px] leading-[1.6] text-slate">{f.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="state" className="border-t border-mist py-16">
          <h2 id="state" className="text-[26px] font-[650] leading-tight">
            Where it stands
          </h2>
          <p className="mt-4 max-w-[64ch] text-[16px] leading-[1.6] text-slate">
            Galena is in active development and has no release yet. Detection, the static page,
            incidents, maintenance and notifications work today; incidents drafted from monitors,
            approvals in Slack and alert ingest are next.
          </p>
          <p className="mt-6">
            <Link href="/docs/roadmap/" className="underline">
              Roadmap
            </Link>
          </p>
        </section>
      </main>
      <footer className="border-t border-mist">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap justify-between gap-4 px-4 py-8 text-[14px] text-slate sm:px-6">
          <span>Galena is open source under the Apache License 2.0.</span>
          <span className="flex gap-6">
            <Link href="/docs/" className="hover:underline">
              Docs
            </Link>
            <a href="https://github.com/astrlme/galena" className="hover:underline">
              GitHub
            </a>
          </span>
        </div>
      </footer>
    </HomeLayout>
  );
}
