import type {
  ComponentGroupId,
  ComponentId,
  ComponentStatus,
  EventEnvelope,
  MonitorConfig,
  MonitorId,
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

// Every lookup is scoped by workspace so no query can reach another tenant's rows.
interface WorkspaceRepository<Entity, Id> {
  /** Ordered by position. */
  listByWorkspace(workspaceId: WorkspaceId): Promise<Entity[]>;
  findById(workspaceId: WorkspaceId, id: Id): Promise<Entity | undefined>;
  /** Inserts or updates by id. */
  save(entity: Entity): Promise<void>;
  delete(workspaceId: WorkspaceId, id: Id): Promise<void>;
  setPositions(workspaceId: WorkspaceId, positions: ReadonlyMap<Id, number>): Promise<void>;
}

export type ComponentRepository = WorkspaceRepository<Component, ComponentId>;

export type ComponentGroup = {
  id: ComponentGroupId;
  workspaceId: WorkspaceId;
  name: string;
  position: number;
};

export type ComponentGroupRepository = WorkspaceRepository<ComponentGroup, ComponentGroupId>;

/** Monitors have no position; they list in creation order (UUIDv7 ids). */
export type MonitorRepository = Omit<WorkspaceRepository<MonitorConfig, MonitorId>, "setPositions">;
