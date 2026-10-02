import { ButtonLink } from "../../components/button.tsx";
import { Wordmark } from "../../components/wordmark.tsx";

export default function Home() {
  return (
    <main className="mx-auto max-w-[720px] px-4 py-12">
      <Wordmark />
      <h1 className="mt-12 text-[32px] font-[650] leading-[1.15]">
        A status page that stays up when everything else is down
      </h1>
      <p className="mt-4 max-w-[72ch] text-[16px] leading-[1.55] text-slate">
        Galena checks your services from three AWS regions, drafts incidents for you to approve, and
        publishes a static page from a region of its own.
      </p>
      <div className="mt-8">
        <ButtonLink href="/sign-in/" variant="primary">
          Sign in
        </ButtonLink>
      </div>
    </main>
  );
}
