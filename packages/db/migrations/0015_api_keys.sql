CREATE TYPE "public"."api_key_scope" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" "api_key_scope" NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_member_fk" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."member"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash_index" ON "api_key" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_key_workspace_id_created_by_user_id_index" ON "api_key" USING btree ("workspace_id","created_by_user_id");--> statement-breakpoint
CREATE CAST (text AS "public"."api_key_scope") WITH INOUT AS IMPLICIT;
