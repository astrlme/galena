import type { Metadata } from "next";
import { Wordmark } from "../../components/wordmark.tsx";
import { SignInForm } from "./sign-in-form.tsx";

export const metadata: Metadata = {
  title: "Sign in to Galena",
  robots: { index: false, follow: false },
};

export default function SignIn() {
  return (
    <main className="mx-auto flex max-w-[400px] flex-col gap-8 px-4 py-12">
      <Wordmark />
      <h1 className="text-[24px] font-semibold leading-[1.25]">Sign in</h1>
      <SignInForm />
    </main>
  );
}
