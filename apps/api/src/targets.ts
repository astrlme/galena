import { createGuard, type Guard, guard } from "@galena/integrations/net";

/**
 * The guard every monitor URL passes. Local development may also reach 127.0.0.1 when
 * GLN_ALLOW_LOOPBACK=1, so a server on this machine can stand in for an outage; every other
 * stage ignores the switch.
 */
export function targetGuard(stage: "local" | "dev" | "prod", allowLoopback: boolean): Guard {
  return stage === "local" && allowLoopback
    ? createGuard({ allowAddresses: ["127.0.0.1"] })
    : guard;
}
