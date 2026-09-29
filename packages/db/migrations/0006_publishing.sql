CREATE TYPE "public"."monitor_state" AS ENUM('unknown', 'up', 'degraded', 'down', 'recovering', 'flapping');--> statement-breakpoint
CREATE SEQUENCE "public"."snapshot_version" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "monitor_state_change" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"from_state" "monitor_state" NOT NULL,
	"to_state" "monitor_state" NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uptime_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"day" date NOT NULL,
	"minutes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "state" "monitor_state" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "state_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "published_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "html_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_state_change" ADD CONSTRAINT "monitor_state_change_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_state_change" ADD CONSTRAINT "monitor_state_change_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_daily" ADD CONSTRAINT "uptime_daily_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_daily" ADD CONSTRAINT "uptime_daily_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_state_change_monitor_id_seq_index" ON "monitor_state_change" USING btree ("monitor_id","seq");--> statement-breakpoint
CREATE INDEX "monitor_state_change_workspace_id_at_index" ON "monitor_state_change" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "uptime_daily_component_id_day_index" ON "uptime_daily" USING btree ("component_id","day");--> statement-breakpoint
CREATE INDEX "uptime_daily_workspace_id_day_index" ON "uptime_daily" USING btree ("workspace_id","day");--> statement-breakpoint
-- The Data API sends strings as text; this lets text fill the new enum columns.
CREATE CAST (text AS "public"."monitor_state") WITH INOUT AS IMPLICIT;
