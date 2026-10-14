CREATE TABLE "signal_receipt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_receipt" ADD CONSTRAINT "signal_receipt_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_receipt" ADD CONSTRAINT "signal_receipt_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_receipt_key_index" ON "signal_receipt" USING btree ("key");--> statement-breakpoint
CREATE INDEX "signal_receipt_workspace_id_index" ON "signal_receipt" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "signal_receipt_integration_id_index" ON "signal_receipt" USING btree ("integration_id");