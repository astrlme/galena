CREATE TYPE "public"."channel_kind" AS ENUM('email', 'slack', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."endpoint_kind" AS ENUM('slack', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."endpoint_state" AS ENUM('active', 'failing', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."subscriber_state" AS ENUM('pending_confirmation', 'active', 'unsubscribed', 'suppressed');--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"subscriber_id" uuid,
	"endpoint_id" uuid,
	"channel" "channel_kind" NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_one_target" CHECK (("delivery"."subscriber_id" is null) <> ("delivery"."endpoint_id" is null))
);
--> statement-breakpoint
CREATE TABLE "subscriber" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"state" "subscriber_state" DEFAULT 'pending_confirmation' NOT NULL,
	"component_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirm_sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "endpoint_kind" NOT NULL,
	"name" text NOT NULL,
	"url_sealed" text NOT NULL,
	"secret_sealed" text,
	"state" "endpoint_state" DEFAULT 'active' NOT NULL,
	"component_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber" ADD CONSTRAINT "subscriber_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_event_id_subscriber_id_index" ON "delivery" USING btree ("event_id","subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_event_id_endpoint_id_index" ON "delivery" USING btree ("event_id","endpoint_id");--> statement-breakpoint
CREATE INDEX "delivery_subscriber_id_index" ON "delivery" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "delivery_endpoint_id_index" ON "delivery" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "delivery_workspace_id_subject_id_index" ON "delivery" USING btree ("workspace_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_workspace_id_email_index" ON "subscriber" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "subscriber_workspace_id_state_index" ON "subscriber" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "subscriber_ip_hash_created_at_index" ON "subscriber" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoint_workspace_id_index" ON "webhook_endpoint" USING btree ("workspace_id");--> statement-breakpoint
-- The Data API sends strings as text; this lets text fill the new enum columns.
CREATE CAST (text AS "public"."channel_kind") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."delivery_status") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."endpoint_kind") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."endpoint_state") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."subscriber_state") WITH INOUT AS IMPLICIT;
