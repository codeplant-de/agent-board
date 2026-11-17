CREATE TABLE "task_pr" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"task_id" text NOT NULL,
	"pr" text NOT NULL,
	"state" "pr_state",
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "task_pr_pr_sealed" CHECK ("task_pr"."pr" ~ '^abe1[.][A-Za-z0-9_-]{38,}$')
);
--> statement-breakpoint
ALTER TABLE "task_pr" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_pr" ADD CONSTRAINT "task_pr_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pr" ADD CONSTRAINT "task_pr_task_fk" FOREIGN KEY ("owner","task_id") REFERENCES "public"."task"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_pr_task_created_idx" ON "task_pr" USING btree ("task_id","created_at");--> statement-breakpoint
INSERT INTO "task_pr" ("id", "owner", "task_id", "pr", "state", "created_at")
SELECT left(md5("id" || ':pr'), 12), "owner", "id", "pr", "pr_state", "updated_at" FROM "task" WHERE "pr" IS NOT NULL;--> statement-breakpoint
UPDATE "task" SET "pr_state" = NULL WHERE "pr" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant" ON "task_pr" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));