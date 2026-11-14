-- Refuses to run while plain text is still stored in a sealed column, so deploying this image before the one-off
-- re-encryption fails here, names the script and changes nothing (the migrations run in one transaction).
-- The author is compared as text: on a fresh database 0013 adds the enum value 'server' in this same transaction, where
-- the value cannot be used yet.
DO $$
DECLARE
	found text;
BEGIN
	SELECT string_agg(format('%s (%s rows)', what, n), ', ') INTO found FROM (
		SELECT 'note.body' AS what, count(*) AS n FROM "note" WHERE NOT (("author"::text = 'server' AND "kind" = 'event') OR "body" ~ '^abe1[.][A-Za-z0-9_-]{38,}$')
		UNION ALL
		SELECT 'task.title', count(*) FROM "task" WHERE "title" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'task.input', count(*) FROM "task" WHERE "input" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'task.workdir', count(*) FROM "task" WHERE "workdir" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'task.dedupe_key', count(*) FROM "task" WHERE "dedupe_key" !~ '^abh1[.][A-Za-z0-9_-]{43}$'
		UNION ALL
		SELECT 'task.head', count(*) FROM "task" WHERE "head" !~ '^abh1[.][A-Za-z0-9_-]{43}$'
		UNION ALL
		SELECT 'schedule.title', count(*) FROM "schedule" WHERE "title" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'schedule.input', count(*) FROM "schedule" WHERE "input" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'schedule.workdir', count(*) FROM "schedule" WHERE "workdir" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'note.preview', count(*) FROM "note" WHERE "preview" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'note.questions', count(*) FROM "note" WHERE "questions" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'note.answers', count(*) FROM "note" WHERE "answers" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'transcript_event.data', count(*) FROM "transcript_event" WHERE "data" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
		UNION ALL
		SELECT 'transcript_event.output', count(*) FROM "transcript_event" WHERE "output" !~ '^abe1[.][A-Za-z0-9_-]{38,}$'
	) counts WHERE n > 0;
	IF found IS NOT NULL THEN
		RAISE EXCEPTION 'Plain text is still stored in sealed columns: %. Run the re-encryption script first (pnpm --filter @agent-board/backend reencrypt; see "Cutover" in the README), then deploy this migration again.', found;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_body_sealed" CHECK (("note"."author"::text = 'server' and "note"."kind" = 'event') or "note"."body" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_preview_sealed" CHECK ("note"."preview" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_questions_sealed" CHECK ("note"."questions" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_answers_sealed" CHECK ("note"."answers" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_title_sealed" CHECK ("schedule"."title" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_input_sealed" CHECK ("schedule"."input" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_workdir_sealed" CHECK ("schedule"."workdir" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_title_sealed" CHECK ("task"."title" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_input_sealed" CHECK ("task"."input" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_workdir_sealed" CHECK ("task"."workdir" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_dedupe_key_blind" CHECK ("task"."dedupe_key" ~ '^abh1[.][A-Za-z0-9_-]{43}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_head_blind" CHECK ("task"."head" ~ '^abh1[.][A-Za-z0-9_-]{43}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_data_sealed" CHECK ("transcript_event"."data" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_output_sealed" CHECK ("transcript_event"."output" ~ '^abe1[.][A-Za-z0-9_-]{38,}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "note" VALIDATE CONSTRAINT "note_body_sealed";
--> statement-breakpoint
ALTER TABLE "note" VALIDATE CONSTRAINT "note_preview_sealed";
--> statement-breakpoint
ALTER TABLE "note" VALIDATE CONSTRAINT "note_questions_sealed";
--> statement-breakpoint
ALTER TABLE "note" VALIDATE CONSTRAINT "note_answers_sealed";
--> statement-breakpoint
ALTER TABLE "schedule" VALIDATE CONSTRAINT "schedule_title_sealed";
--> statement-breakpoint
ALTER TABLE "schedule" VALIDATE CONSTRAINT "schedule_input_sealed";
--> statement-breakpoint
ALTER TABLE "schedule" VALIDATE CONSTRAINT "schedule_workdir_sealed";
--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_title_sealed";
--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_input_sealed";
--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_workdir_sealed";
--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_dedupe_key_blind";
--> statement-breakpoint
ALTER TABLE "task" VALIDATE CONSTRAINT "task_head_blind";
--> statement-breakpoint
ALTER TABLE "transcript_event" VALIDATE CONSTRAINT "transcript_event_data_sealed";
--> statement-breakpoint
ALTER TABLE "transcript_event" VALIDATE CONSTRAINT "transcript_event_output_sealed";
