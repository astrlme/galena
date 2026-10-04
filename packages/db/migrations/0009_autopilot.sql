ALTER TABLE "incident" ADD COLUMN "dedup_key" text;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "approval_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "approval_token_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_open_dedup_idx" ON "incident" USING btree ("workspace_id","dedup_key") WHERE "incident"."resolved_at" is null and "incident"."deleted_at" is null and "incident"."visibility" <> 'dismissed';