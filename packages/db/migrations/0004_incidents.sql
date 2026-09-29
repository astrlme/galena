CREATE TYPE "public"."incident_impact" AS ENUM('none', 'minor', 'major', 'critical');--> statement-breakpoint
CREATE TYPE "public"."incident_source" AS ENUM('manual', 'monitor', 'signal');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('investigating', 'identified', 'monitoring', 'resolved', 'postmortem');--> statement-breakpoint
CREATE TYPE "public"."incident_visibility" AS ENUM('draft', 'published', 'dismissed', 'internal');--> statement-breakpoint
CREATE TYPE "public"."timeline_event_kind" AS ENUM('status_changed', 'note', 'signal');--> statement-breakpoint
CREATE TABLE "incident" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "incident_status" NOT NULL,
	"impact" "incident_impact" NOT NULL,
	"visibility" "incident_visibility" DEFAULT 'published' NOT NULL,
	"source" "incident_source" DEFAULT 'manual' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_component" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"status" "component_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_update" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" "incident_status" NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" timeline_event_kind NOT NULL,
	"data" jsonb NOT NULL,
	"actor_user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_component" ADD CONSTRAINT "incident_component_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_component" ADD CONSTRAINT "incident_component_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_component" ADD CONSTRAINT "incident_component_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_update" ADD CONSTRAINT "incident_update_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_update" ADD CONSTRAINT "incident_update_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_update" ADD CONSTRAINT "incident_update_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_workspace_id_started_at_index" ON "incident" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "incident_open_idx" ON "incident" USING btree ("workspace_id") WHERE "incident"."resolved_at" is null and "incident"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_component_incident_id_component_id_index" ON "incident_component" USING btree ("incident_id","component_id");--> statement-breakpoint
CREATE INDEX "incident_component_component_id_index" ON "incident_component" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "incident_component_workspace_id_index" ON "incident_component" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "incident_update_incident_id_created_at_index" ON "incident_update" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_update_workspace_id_index" ON "incident_update" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "incident_update_created_by_user_id_index" ON "incident_update" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "timeline_event_incident_id_occurred_at_index" ON "timeline_event" USING btree ("incident_id","occurred_at");--> statement-breakpoint
CREATE INDEX "timeline_event_workspace_id_index" ON "timeline_event" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "timeline_event_actor_user_id_index" ON "timeline_event" USING btree ("actor_user_id");--> statement-breakpoint
-- The Data API sends strings as text; these let text fill the new enum columns, as 0003 does.
CREATE CAST (text AS "public"."incident_status") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."incident_impact") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."incident_visibility") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."incident_source") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."timeline_event_kind") WITH INOUT AS IMPLICIT;
