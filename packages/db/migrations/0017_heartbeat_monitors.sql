ALTER TYPE "public"."monitor_type" ADD VALUE 'heartbeat';--> statement-breakpoint
ALTER TABLE "monitor" ALTER COLUMN "http" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "heartbeat" jsonb;