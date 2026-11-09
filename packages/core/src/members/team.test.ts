import { type MemberRole, memberRoles } from "@galena/contracts";
import fc from "fast-check";
import { expect, test } from "vitest";
import { checkInvite, checkTeamChange, inviteState } from "./team.ts";

const change = (
  actor: MemberRole,
  from: MemberRole | null,
  to: MemberRole | "removed",
  owners = 2,
) => checkTeamChange({ actor, from, to, owners });
const code = (result: ReturnType<typeof checkTeamChange>) => (result.ok ? "ok" : result.error.code);

test("admins and owners manage the team; editors and viewers can't", () => {
  expect(code(change("admin", null, "viewer"))).toBe("ok");
  expect(code(change("owner", "editor", "admin"))).toBe("ok");
  expect(code(change("admin", "viewer", "removed"))).toBe("ok");
  expect(code(change("editor", null, "viewer"))).toBe("not_allowed");
  expect(code(change("viewer", "editor", "removed"))).toBe("not_allowed");
});

test("only an owner makes, changes or removes an owner", () => {
  expect(code(change("admin", null, "owner"))).toBe("not_allowed");
  expect(code(change("admin", "editor", "owner"))).toBe("not_allowed");
  expect(code(change("admin", "owner", "admin"))).toBe("not_allowed");
  expect(code(change("admin", "owner", "removed"))).toBe("not_allowed");
  expect(code(change("owner", null, "owner"))).toBe("ok");
  expect(code(change("owner", "owner", "removed", 2))).toBe("ok");
});

test("the last owner can be neither removed nor made anything else", () => {
  expect(code(change("owner", "owner", "removed", 1))).toBe("last_owner");
  expect(code(change("owner", "owner", "admin", 1))).toBe("last_owner");
  expect(code(change("owner", "owner", "owner", 1))).toBe("ok");
});

test("no run of allowed changes leaves the team without an owner", () => {
  const roles = fc.constantFrom(...memberRoles);
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.nat({ max: 9 }),
          fc.nat({ max: 9 }),
          fc.oneof(roles, fc.constant("removed" as const)),
        ),
        {
          maxLength: 60,
        },
      ),
      (steps) => {
        // Ten seats, one owner to start; each step is someone acting on someone.
        const team: (MemberRole | null)[] = [
          "owner",
          "admin",
          "editor",
          "viewer",
          null,
          null,
          null,
          null,
          null,
          null,
        ];
        for (const [by, on, to] of steps) {
          const actor = team[by];
          const from = team[on] ?? null;
          if (!actor || (from === null && to === "removed")) continue;
          const owners = team.filter((r) => r === "owner").length;
          if (checkTeamChange({ actor, from, to, owners }).ok)
            team[on] = to === "removed" ? null : to;
          expect(team.filter((r) => r === "owner").length).toBeGreaterThan(0);
        }
      },
    ),
  );
});

test("an invite for an owner, or acting on one, takes an owner", () => {
  expect(checkInvite("owner", "owner").ok).toBe(true);
  expect(checkInvite("admin", "owner").ok).toBe(false);
  expect(checkInvite("admin", "admin").ok).toBe(true);
  expect(checkInvite("editor", "viewer").ok).toBe(false);
});

test("an invite is open until it's used, revoked or past its time", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  const later = new Date("2026-11-10T12:00:00.000Z");
  const open = { acceptedAt: null, revokedAt: null, expiresAt: later };
  expect(inviteState(open, now)).toBe("open");
  expect(inviteState({ ...open, acceptedAt: now }, now)).toBe("used");
  expect(inviteState({ ...open, revokedAt: now }, now)).toBe("revoked");
  expect(inviteState(open, later)).toBe("expired");
});
