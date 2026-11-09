"use client";

import { type MemberRole, memberRoles } from "@galena/contracts";
import { memberRoleLabels, memberRoleSummaries } from "@galena/contracts/copy";
import { checkInvite, checkTeamChange } from "@galena/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { Modal } from "../../../components/modal.tsx";
import { columnsFor, DataTable } from "../../../components/ui/data-table.tsx";
import { Loading } from "../../../components/ui/loading.tsx";
import { RowMenu } from "../../../components/ui/row-menu.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { toast } from "../../../components/ui/toast.tsx";
import type { Answer } from "../../../lib/answer.ts";
import { api, unwrap } from "../../../lib/api.ts";
import { Time } from "../incidents/incident-ui.tsx";
import { grantable, roleOptions } from "./roles.ts";
import { InviteSheet } from "./team-invite.tsx";

type TeamMember = Answer<"/v1/team">["members"][number];
type OpenInvite = Answer<"/v1/team">["invites"][number];

// The workspace's people. Everyone sees who is on the team; admins and owners invite, change
// roles and remove, and the menus offer only what the team rules allow.

const heading = "text-[19px] font-semibold leading-[1.35]";
const card = "mt-4 rounded-xl border border-mist bg-surface";

const memberColumn = columnsFor<TeamMember>();
const MEMBER_COLUMNS = memberColumn.columns([
  memberColumn.accessor("name", {
    header: "Name",
    cell: (c) => (
      <span className="font-semibold">
        {c.getValue()}
        {c.row.original.isYou && <span className="font-normal text-slate"> (you)</span>}
      </span>
    ),
  }),
  memberColumn.accessor("email", { header: "Email", enableSorting: false }),
  memberColumn.accessor("role", { header: "Role", cell: (c) => memberRoleLabels[c.getValue()] }),
  memberColumn.accessor("joinedAt", { header: "Joined", cell: (c) => <Time iso={c.getValue()} /> }),
]);

const inviteColumn = columnsFor<OpenInvite>();
const INVITE_COLUMNS = inviteColumn.columns([
  inviteColumn.accessor("email", {
    header: "Email",
    cell: (c) => <span className="font-semibold">{c.getValue()}</span>,
  }),
  inviteColumn.accessor("role", { header: "Role", cell: (c) => memberRoleLabels[c.getValue()] }),
  inviteColumn.accessor("expiresAt", {
    header: "Link works until",
    cell: (c) => <Time iso={c.getValue()} />,
  }),
  inviteColumn.accessor("invitedBy", {
    header: "Invited by",
    enableSorting: false,
    cell: (c) => c.getValue() ?? "Someone who left",
  }),
]);

export function Team() {
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState<TeamMember>();
  const [removing, setRemoving] = useState<TeamMember>();
  const [cancelling, setCancelling] = useState<OpenInvite>();
  const [problem, setProblem] = useState<string>();
  const me = useQuery({ queryKey: ["me"], queryFn: () => unwrap(api.GET("/v1/me")) });
  const team = useQuery({ queryKey: ["team"], queryFn: () => unwrap(api.GET("/v1/team")) });
  const change = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["team"] }),
  });

  const actor = memberRoles.find((r) => r === me.data?.role);
  const members = team.data?.members ?? [];
  const owners = members.filter((m) => m.role === "owner").length;
  const may = (from: MemberRole, to: MemberRole | "removed") =>
    actor !== undefined && checkTeamChange({ actor, from, to, owners }).ok;
  const canInvite = actor !== undefined && grantable(actor).length > 0;
  // A role can change if the member may become something other than what they are.
  const canChange = (m: TeamMember) => memberRoles.some((to) => to !== m.role && may(m.role, to));

  return (
    <section className="mt-8" aria-labelledby="team-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="team-heading" ref={headingRef} tabIndex={-1} className={heading}>
          Team
        </h2>
        {team.isSuccess && canInvite && (
          <Button onClick={() => setInviting(true)}>Invite someone</Button>
        )}
      </div>
      <dl className="mt-2 grid max-w-[72ch] grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[14px] text-slate">
        {memberRoles.toReversed().map((role) => (
          <div key={role} className="contents">
            <dt className="font-semibold text-graphite">{memberRoleLabels[role]}</dt>
            <dd>{memberRoleSummaries[role]}</dd>
          </div>
        ))}
      </dl>
      {team.isPending ? (
        <Loading label="Loading the team" className="mt-4" rows={2} table />
      ) : team.error ? (
        <p className={`${card} p-4 font-semibold`}>{team.error.message}</p>
      ) : (
        <>
          <DataTable
            label="Members"
            data={members}
            columns={MEMBER_COLUMNS}
            actions={(m) => {
              const actions = [
                ...(canChange(m) ? [{ label: "Change role", onSelect: () => setChanging(m) }] : []),
                ...(may(m.role, "removed")
                  ? [{ label: "Remove", destructive: true, onSelect: () => setRemoving(m) }]
                  : []),
              ];
              return actions.length > 0 ? <RowMenu name={m.name} actions={actions} /> : null;
            }}
          />
          {owners === 1 && actor === "owner" && (
            <p className="mt-2 text-[14px] text-slate">
              You're the only owner: make someone else an owner before you step down or leave.
            </p>
          )}
          {team.data.invites.length > 0 && (
            <>
              <h3 className="mt-6 text-[16px] font-semibold">Open invites</h3>
              <DataTable
                label="Open invites"
                data={team.data.invites}
                columns={INVITE_COLUMNS}
                actions={(i) =>
                  actor && checkInvite(actor, i.role).ok ? (
                    <RowMenu
                      name={i.email}
                      actions={[
                        {
                          label: "Cancel invite",
                          destructive: true,
                          onSelect: () => setCancelling(i),
                        },
                      ]}
                    />
                  ) : null
                }
              />
            </>
          )}
        </>
      )}
      <p role="status" className="mt-3 text-[14px] font-semibold empty:hidden">
        {changing ? undefined : problem}
      </p>

      {actor && (
        <InviteSheet
          open={inviting}
          roles={grantable(actor)}
          onClose={() => {
            setInviting(false);
            void queryClient.invalidateQueries({ queryKey: ["team"] });
          }}
        />
      )}
      {changing && (
        <ChangeRole
          member={changing}
          roles={memberRoles.filter((to) => to === changing.role || may(changing.role, to))}
          pending={change.isPending}
          problem={problem}
          onClose={() => {
            setChanging(undefined);
            setProblem(undefined);
          }}
          onSave={(role) =>
            change.mutate(
              () =>
                unwrap(
                  api.PATCH("/v1/members/{id}", {
                    params: { path: { id: changing.id } },
                    body: { role },
                  }),
                ),
              {
                onSuccess: () => {
                  toast("Role changed");
                  setChanging(undefined);
                },
              },
            )
          }
        />
      )}
      {removing && (
        <ConfirmDelete
          kind="member"
          verb="Remove"
          name={removing.name}
          noun="member's name"
          consequence="They're signed out at once, and their API keys stop working."
          onConfirm={() => {
            const params = { path: { id: removing.id } };
            change.mutate(() => unwrap(api.DELETE("/v1/members/{id}", { params })), {
              onSuccess: () => {
                toast("Member removed");
                headingRef.current?.focus();
              },
            });
            setRemoving(undefined);
          }}
          onClose={() => setRemoving(undefined)}
        />
      )}
      {cancelling && (
        <ConfirmDelete
          kind="invite"
          verb="Cancel"
          name={cancelling.email}
          noun="address"
          consequence="Its link stops working at once."
          onConfirm={() => {
            const params = { path: { id: cancelling.id } };
            change.mutate(() => unwrap(api.DELETE("/v1/invites/{id}", { params })), {
              onSuccess: () => {
                toast("Invite cancelled");
                headingRef.current?.focus();
              },
            });
            setCancelling(undefined);
          }}
          onClose={() => setCancelling(undefined)}
        />
      )}
    </section>
  );
}

function ChangeRole({
  member,
  roles,
  pending,
  problem,
  onSave,
  onClose,
}: {
  member: TeamMember;
  roles: MemberRole[];
  pending: boolean;
  problem: string | undefined;
  onSave: (role: MemberRole) => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<MemberRole>(member.role);
  return (
    <Modal.Root kind="dialog" open onClose={onClose}>
      <Modal.Title>Change {member.name}'s role</Modal.Title>
      <form
        className="mt-6 flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(role);
        }}
      >
        <Select label="Role" value={role} onChange={setRole} options={roleOptions(roles)} />
        <p aria-live="polite" className="font-semibold text-major empty:hidden">
          {problem}
        </p>
        <div className="flex gap-4">
          <Button type="submit" variant="primary" disabled={pending || role === member.role}>
            {pending ? "Changing…" : "Change role"}
          </Button>
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal.Root>
  );
}
