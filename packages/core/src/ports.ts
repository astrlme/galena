import type {
  ComponentGroupId,
  ComponentId,
  ComponentStatus,
  EventEnvelope,
  WorkspaceId,
} from "@galena/contracts";

// Core does no I/O: adapters in packages/db, apps/workers and the apps implement
// these ports, and tests use in-memory fakes.

/** The only source of time in core. Never `Date.now()` or `new Date()` without an argument. */
export interface Clock {
  now(): Date;
}

/** A clock stopped at `iso`, for tests and replays. */
export function fixedClock(iso: string): Clock {
  const at = new Date(iso);
  return { now: () => new Date(at) };
}

/** Records domain events; the database adapter writes them to the outbox in the same transaction. */
export interface EventBus {
  publish(event: EventEnvelope<string, unknown>): Promise<void>;
}

/** Starts durable workflows (trigger.dev in production), always with an idempotency key. */
export interface WorkflowEngine {
  trigger(
    task: string,
    payload: unknown,
    options: { idempotencyKey: string; delay?: string },
  ): Promise<void>;
}

export type Component = {
  id: ComponentId;
  workspaceId: WorkspaceId;
  groupId: ComponentGroupId | null;
  name: string;
  description: string | null;
  position: number;
  status: ComponentStatus;
  manualStatus: ComponentStatus | null;
};

export interface ComponentRepository {
  listByWorkspace(workspaceId: WorkspaceId): Promise<Component[]>;
  findById(id: ComponentId): Promise<Component | undefined>;
  save(component: Component): Promise<void>;
  delete(id: ComponentId): Promise<void>;
}
