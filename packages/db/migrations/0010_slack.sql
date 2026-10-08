CREATE TABLE "slack_installation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"bot_token_sealed" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"installed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_installation" ADD CONSTRAINT "slack_installation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installation" ADD CONSTRAINT "slack_installation_installed_by_user_id_user_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installation_workspace_id_index" ON "slack_installation" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installation_team_id_index" ON "slack_installation" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "slack_installation_installed_by_user_id_index" ON "slack_installation" USING btree ("installed_by_user_id");