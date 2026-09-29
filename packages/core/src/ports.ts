import type {
  AffectedComponent,
  ComponentGroupId,
  ComponentId,
  ComponentStatus,
  EventEnvelope,
  IncidentId,
  IncidentImpact,
  IncidentSource,
  IncidentStatus,
  IncidentUpdateId,
  IncidentVisibility,
  MaintenanceId,
  MaintenanceStatus,
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
    /** `tags` label the run, e.g. with the correlation id, so it can be found later. */
    options: { idempotencyKey: string; delay?: string; tags?: string[] },
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

/** Where an incident is in its lifecycle. */
export type IncidentStage = { status: IncidentStatus; resolvedAt: Date | null };

export type Incident = IncidentStage & {
  id: IncidentId;
  workspaceId: WorkspaceId;
  title: string;
  impact: IncidentImpact;
  visibility: IncidentVisibility;
  source: IncidentSource;
  startedAt: Date;
  /** When the last update was posted. */
  updatedAt: Date;
  components: AffectedComponent[];
};

export type IncidentUpdate = {
  id: IncidentUpdateId;
  status: IncidentStatus;
  body: string;
  createdAt: Date;
};

/** One posted update and what it changes; the repository writes it all in the caller's transaction. */
export type IncidentChange = {
  update: IncidentUpdate & { createdByUserId: string | null };
  stage: IncidentStage;
  impact?: IncidentImpact;
  /** Replaces the affected components when present. */
  components?: AffectedComponent[];
  /** Recorded on the timeline when the status moved. */
  statusChange?: { from: IncidentStatus | null; to: IncidentStatus };
};

export interface IncidentRepository {
  /** Open (not resolved) or resolved incidents, newest first. Soft-deleted ones never appear. */
  list(workspaceId: WorkspaceId, filter: { open: boolean }): Promise<Incident[]>;
  /** With its updates, newest first. */
  findById(
    workspaceId: WorkspaceId,
    id: IncidentId,
  ): Promise<(Incident & { updates: IncidentUpdate[] }) | undefined>;
  create(
    incident: Omit<Incident, "updatedAt" | "components" | keyof IncidentStage>,
    first: IncidentChange,
  ): Promise<void>;
  /**
   * Writes the change only while the incident still has status `expected`, so two people
   * updating at once can't take it through a move the lifecycle forbids. False when it moved.
   */
  append(
    workspaceId: WorkspaceId,
    id: IncidentId,
    expected: IncidentStatus,
    change: IncidentChange,
  ): Promise<boolean>;
}

export type Maintenance = {
  id: MaintenanceId;
  workspaceId: WorkspaceId;
  title: string;
  body: string;
  status: MaintenanceStatus;
  startsAt: Date;
  endsAt: Date;
  /** Counts edits; the lifecycle run for an older version stops when it wakes. */
  version: number;
  /** The lifecycle run for the current version, once started. */
  runId: string | null;
  cancelledAt: Date | null;
  componentIds: ComponentId[];
};

export interface MaintenanceRepository {
  /** Newest start first. Soft-deleted windows never appear. */
  list(workspaceId: WorkspaceId): Promise<Maintenance[]>;
  findById(workspaceId: WorkspaceId, id: MaintenanceId): Promise<Maintenance | undefined>;
  /**
   * Inserts (`expectedVersion` null) or replaces a window that hasn't completed, components
   * included. False when someone else edited it first or it has completed.
   */
  save(window: Omit<Maintenance, "runId">, expectedVersion: number | null): Promise<boolean>;
  /** Moves the status only while the version and status are still the ones read. */
  transition(
    workspaceId: WorkspaceId,
    id: MaintenanceId,
    from: { version: number; status: MaintenanceStatus },
    to: { status: MaintenanceStatus; cancelledAt?: Date },
  ): Promise<boolean>;
  setRunId(id: MaintenanceId, version: number, runId: string): Promise<void>;
  /** Every window not yet completed, across the deployment, for `monitors.json`. */
  listUnfinished(): Promise<Maintenance[]>;
}
