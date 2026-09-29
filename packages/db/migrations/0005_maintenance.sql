CREATE TYPE "public"."maintenance_status" AS ENUM('scheduled', 'in_progress', 'verifying', 'completed');--> statement-breakpoint
CREATE TABLE "maintenance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "maintenance_status" DEFAULT 'scheduled' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"run_id" text,
	"cancelled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_component" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"maintenance_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenance" ADD CONSTRAINT "maintenance_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_component" ADD CONSTRAINT "maintenance_component_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_component" ADD CONSTRAINT "maintenance_component_maintenance_id_maintenance_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_component" ADD CONSTRAINT "maintenance_component_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_workspace_id_starts_at_index" ON "maintenance" USING btree ("workspace_id","starts_at");--> statement-breakpoint
CREATE INDEX "maintenance_unfinished_idx" ON "maintenance" USING btree ("starts_at") WHERE "maintenance"."status" <> 'completed' and "maintenance"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_component_maintenance_id_component_id_index" ON "maintenance_component" USING btree ("maintenance_id","component_id");--> statement-breakpoint
CREATE INDEX "maintenance_component_component_id_index" ON "maintenance_component" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "maintenance_component_workspace_id_index" ON "maintenance_component" USING btree ("workspace_id");--> statement-breakpoint
-- The Data API sends strings as text; this lets text fill the new enum column.
CREATE CAST (text AS "public"."maintenance_status") WITH INOUT AS IMPLICIT;
