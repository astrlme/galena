CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_workspace_id_index" ON "invite" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invite_invited_by_user_id_index" ON "invite" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_open_email_idx" ON "invite" USING btree ("workspace_id","email") WHERE "invite"."accepted_at" is null and "invite"."revoked_at" is null;