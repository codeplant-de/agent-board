CREATE TABLE "app_user" (
	"username" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_username_not_empty" CHECK ("app_user"."username" <> '')
);
--> statement-breakpoint
DO $$
DECLARE
	backfill text := nullif(current_setting('app.backfill_owner', true), '');
BEGIN
	IF backfill IS NULL THEN
		IF EXISTS (SELECT 1 FROM "task") OR EXISTS (SELECT 1 FROM "schedule") OR EXISTS (SELECT 1 FROM "note")
			OR EXISTS (SELECT 1 FROM "machine") OR EXISTS (SELECT 1 FROM "transcript_run")
			OR EXISTS (SELECT 1 FROM "transcript_event") THEN
			RAISE EXCEPTION 'The database has rows without an owner: set BACKFILL_OWNER to the username that owns them';
		END IF;
	ELSE
		INSERT INTO "app_user" ("username") VALUES (backfill);
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "note" DROP CONSTRAINT "note_task_id_task_id_fk";
--> statement-breakpoint
ALTER TABLE "schedule" DROP CONSTRAINT "schedule_occurrence_task_id_task_id_fk";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_parent_id_task_id_fk";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_schedule_id_schedule_id_fk";
--> statement-breakpoint
ALTER TABLE "transcript_event" DROP CONSTRAINT "transcript_event_run_id_transcript_run_id_fk";
--> statement-breakpoint
ALTER TABLE "transcript_run" DROP CONSTRAINT "transcript_run_task_id_task_id_fk";
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "owner" text DEFAULT nullif(current_setting('app.backfill_owner', true), '') NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "owner" text DEFAULT nullif(current_setting('app.backfill_owner', true), '') NOT NULL;
--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "owner" text DEFAULT nullif(current_setting('app.backfill_owner', true), '') NOT NULL;
--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "owner" text DEFAULT nullif(current_setting('app.backfill_owner', true), '') NOT NULL;
--> statement-breakpoint
ALTER TABLE "transcript_run" ADD COLUMN "owner" text DEFAULT nullif(current_setting('app.backfill_owner', true), '') NOT NULL;
--> statement-breakpoint
ALTER TABLE "transcript_event" ADD COLUMN "owner" text DEFAULT nullif(current_setting('app.backfill_owner', true), '') NOT NULL;
--> statement-breakpoint
ALTER TABLE "task" ALTER COLUMN "owner" SET DEFAULT current_setting('app.owner', true);
--> statement-breakpoint
ALTER TABLE "schedule" ALTER COLUMN "owner" SET DEFAULT current_setting('app.owner', true);
--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "owner" SET DEFAULT current_setting('app.owner', true);
--> statement-breakpoint
ALTER TABLE "machine" ALTER COLUMN "owner" SET DEFAULT current_setting('app.owner', true);
--> statement-breakpoint
ALTER TABLE "transcript_run" ALTER COLUMN "owner" SET DEFAULT current_setting('app.owner', true);
--> statement-breakpoint
ALTER TABLE "transcript_event" ALTER COLUMN "owner" SET DEFAULT current_setting('app.owner', true);
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_dedupe_key_unique";
--> statement-breakpoint
ALTER TABLE "machine" DROP CONSTRAINT "machine_pkey";
--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_owner_name_pk" PRIMARY KEY("owner","name");
--> statement-breakpoint
ALTER TABLE "transcript_event" DROP CONSTRAINT "transcript_event_run_id_seq_pk";
--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_owner_run_id_seq_pk" PRIMARY KEY("owner","run_id","seq");
--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_owner_id_unique" UNIQUE("owner","id");
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_dedupe_key_unique" UNIQUE("owner","dedupe_key");
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_id_unique" UNIQUE("owner","id");
--> statement-breakpoint
ALTER TABLE "transcript_run" ADD CONSTRAINT "transcript_run_owner_id_unique" UNIQUE("owner","id");
--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_run" ADD CONSTRAINT "transcript_run_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_task_fk" FOREIGN KEY ("owner","task_id") REFERENCES "public"."task"("owner","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_occurrence_task_fk" FOREIGN KEY ("owner","occurrence_task_id") REFERENCES "public"."task"("owner","id") ON DELETE set null ("occurrence_task_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_fk" FOREIGN KEY ("owner","parent_id") REFERENCES "public"."task"("owner","id") ON DELETE set null ("parent_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_schedule_fk" FOREIGN KEY ("owner","schedule_id") REFERENCES "public"."schedule"("owner","id") ON DELETE set null ("schedule_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_run_fk" FOREIGN KEY ("owner","run_id") REFERENCES "public"."transcript_run"("owner","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_run" ADD CONSTRAINT "transcript_run_task_fk" FOREIGN KEY ("owner","task_id") REFERENCES "public"."task"("owner","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "task_status_priority_position_idx";
--> statement-breakpoint
CREATE INDEX "task_status_priority_position_idx" ON "task" USING btree ("owner","status","priority","position");
--> statement-breakpoint
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "machine" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "note" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "transcript_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "transcript_run" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant" ON "machine" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE POLICY "tenant" ON "note" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE POLICY "tenant" ON "schedule" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE POLICY "tenant" ON "task" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE POLICY "tenant" ON "transcript_event" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE POLICY "tenant" ON "transcript_run" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE POLICY "tenant" ON "app_user" AS PERMISSIVE FOR ALL TO "board_app" USING (username = (select current_setting('app.owner', true))) WITH CHECK (username = (select current_setting('app.owner', true)));
--> statement-breakpoint
CREATE FUNCTION "machine_for_token"("hash" text) RETURNS TABLE ("owner" text, "name" text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	UPDATE public.machine SET last_seen_at = now()
	WHERE machine.token_hash = "hash" AND machine.revoked_at IS NULL
	RETURNING machine.owner, machine.name
$$;
--> statement-breakpoint
CREATE FUNCTION "board_owners"() RETURNS TABLE ("username" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT app_user.username FROM public.app_user ORDER BY app_user.username
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "machine_for_token"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "board_owners"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "machine_for_token"(text) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "board_owners"() TO board_app;