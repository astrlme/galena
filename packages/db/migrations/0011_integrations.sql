CREATE TYPE "public"."signal_outcome" AS ENUM('opened', 'attached', 'repeat', 'resolved', 'no_incident', 'no_route', 'suppressed', 'internal_only');--> statement-breakpoint
CREATE TYPE "public"."signal_source" AS ENUM('alertmanager', 'generic');--> statement-breakpoint
CREATE TABLE "integration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" "signal_source" NOT NULL,
	"name" text NOT NULL,
	"publish_policy" "publish_policy" DEFAULT 'approve' NOT NULL,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_issued_at" timestamp with time zone NOT NULL,
	"last_signal_at" timestamp with time zone,
	"last_outcome" "signal_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_workspace_id_index" ON "integration" USING btree ("workspace_id");--> statement-breakpoint
CREATE CAST (text AS "public"."signal_outcome") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."signal_source") WITH INOUT AS IMPLICIT;
