CREATE TYPE "public"."down_status" AS ENUM('partial_outage', 'major_outage');--> statement-breakpoint
CREATE TYPE "public"."monitor_type" AS ENUM('http');--> statement-breakpoint
CREATE TYPE "public"."publish_policy" AS ENUM('auto', 'approve', 'internal_only');--> statement-breakpoint
CREATE TABLE "monitor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"component_id" uuid,
	"name" text NOT NULL,
	"type" "monitor_type" NOT NULL,
	"http" jsonb NOT NULL,
	"publish_policy" "publish_policy" DEFAULT 'approve' NOT NULL,
	"down_status" "down_status" DEFAULT 'major_outage' NOT NULL,
	"detection" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_workspace_id_index" ON "monitor" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "monitor_component_id_index" ON "monitor" USING btree ("component_id");