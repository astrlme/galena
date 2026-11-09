"use client";

import { inviteAccept } from "@galena/contracts";
import { memberRoleInvitations } from "@galena/contracts/copy";
import { zodResolver } from "@hookform/resolvers/zod";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../components/button.tsx";
import { Field } from "../../components/field.tsx";
import { Loading } from "../../components/ui/loading.tsx";
import type { Answer } from "../../lib/answer.ts";
import { api, authGet, unwrap } from "../../lib/api.ts";

// Accepting an invite: what it's for, then a name and a password for a new account, or, for an
// address that has an account already, accepting while signed in as it. Outside the dashboard,
// so the page keeps a query cache of its own.

type Signed = { user: { email: string } } | null;
type Preview = Answer<"/v1/invites/preview">;

const newAccount = inviteAccept.pick({ name: true, password: true }).required();
type NewAccount = z.infer<typeof newAccount>;

export function InviteForm() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Invite />
    </QueryClientProvider>
  );
}

function Invite() {
  const token = useSearchParams().get("token") ?? "";
  const preview = useQuery({
    queryKey: ["invite", token],
    queryFn: () => unwrap(api.GET("/v1/invites/preview", { params: { query: { token } } })),
    enabled: token !== "",
  });
  const signedIn = useQuery({
    queryKey: ["session"],
    queryFn: () => authGet<Signed>("get-session").catch(() => null),
    enabled: preview.data?.hasAccount === true,
  });

  if (token === "") {
    return <Refused>This link has no invite in it. Open the link from the email again.</Refused>;
  }
  if (preview.isPending || (preview.data?.hasAccount && signedIn.isPending)) {
    return <Loading label="Loading the invite" rows={2} framed={false} className="" />;
  }
  if (preview.error) {
    // A refusal from the API carries its own words; anything else is the network.
    return preview.error instanceof TypeError ? (
      <div className="flex flex-col gap-4">
        <h1 className="text-[24px] leading-[1.25] font-semibold">Couldn't load the invite</h1>
        <p>Check your connection, then reload the page.</p>
      </div>
    ) : (
      <Refused>{preview.error.message}</Refused>
    );
  }
  const invite = preview.data;
  const intro = (
    <>
      <h1 className="text-[24px] leading-[1.25] font-semibold">Join {invite.workspaceName}</h1>
      <p className="text-[16px]">{memberRoleInvitations[invite.role]}</p>
    </>
  );
  if (invite.hasAccount) {
    return (
      <ExistingAccount
        token={token}
        invite={invite}
        isThem={signedIn.data?.user.email.toLowerCase() === invite.email}
        intro={intro}
      />
    );
  }
  return <NewAccountForm token={token} invite={invite} intro={intro} />;
}

/** Joins with the invite, then into the dashboard; the API's refusal comes back as the error. */
async function accept(token: string, body: Partial<NewAccount>) {
  await unwrap(api.POST("/v1/invites/accept", { body: { token, ...body } }));
  window.location.assign("/dashboard/");
}

function NewAccountForm({
  token,
  invite,
  intro,
}: {
  token: string;
  invite: Preview;
  intro: React.ReactNode;
}) {
  const [problem, setProblem] = useState<string>();
  const form = useForm<NewAccount>({
    resolver: zodResolver(newAccount),
    defaultValues: { name: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    setProblem(undefined);
    await accept(token, values).catch((error: unknown) =>
      setProblem(error instanceof Error ? error.message : "Couldn't accept the invite. Try again."),
    );
  });
  return (
    <form
      onSubmit={submit}
      aria-label="Accept the invite"
      className="flex flex-col gap-6"
      noValidate
    >
      {intro}
      <div className="flex flex-col gap-1">
        <span className="text-[14px] font-semibold">Email</span>
        <span className="[overflow-wrap:anywhere]">{invite.email}</span>
      </div>
      <Field
        id="name"
        label="Your name"
        autoComplete="name"
        error={errors.name?.message}
        {...form.register("name")}
      />
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        help="At least 12 characters."
        error={errors.password?.message}
        {...form.register("password")}
      />
      <p role="alert" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? "Accepting…" : "Accept invite"}
        </Button>
      </div>
    </form>
  );
}

function ExistingAccount({
  token,
  invite,
  isThem,
  intro,
}: {
  token: string;
  invite: Preview;
  isThem: boolean;
  intro: React.ReactNode;
}) {
  const [problem, setProblem] = useState<string>();
  const [pending, setPending] = useState(false);
  const back = `/sign-in/?next=${encodeURIComponent(`/invite/?token=${token}`)}`;
  return (
    <div className="flex flex-col gap-6">
      {intro}
      {isThem ? (
        <>
          <p>You're signed in as {invite.email}.</p>
          <p role="alert" className="font-semibold text-major empty:hidden">
            {problem}
          </p>
          <div>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setProblem(undefined);
                accept(token, {})
                  .catch((error: unknown) =>
                    setProblem(
                      error instanceof Error
                        ? error.message
                        : "Couldn't accept the invite. Try again.",
                    ),
                  )
                  .finally(() => setPending(false));
              }}
            >
              {pending ? "Accepting…" : "Accept invite"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            {invite.email} has an account here already. Sign in with that address and you'll come
            back here to accept.
          </p>
          <div>
            <a href={back} className="font-semibold underline underline-offset-2">
              Sign in as {invite.email}
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function Refused({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[24px] leading-[1.25] font-semibold">This invite can't be used</h1>
      <p className="font-semibold">{children}</p>
      <a href="/sign-in/" className="underline underline-offset-2">
        Sign in instead
      </a>
    </div>
  );
}
