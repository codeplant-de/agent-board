ALTER TABLE "task" ADD COLUMN "run_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "head" text;--> statement-breakpoint
UPDATE "task" SET "run_started_at" = coalesce(
	(SELECT max("created_at") FROM "note" WHERE "note"."task_id" = "task"."id" AND "note"."author" = 'system' AND "note"."body" LIKE 'agent-board: started%'),
	"updated_at"
) WHERE "status" = 'running';--> statement-breakpoint
UPDATE "task" SET "head" = (regexp_match("input", '^[ \t]*head:[ \t]*([0-9a-fA-F]{7,40})[ \t]*$', 'n'))[1] WHERE "input" ~ '(?n)^[ \t]*head:[ \t]*[0-9a-fA-F]{7,40}[ \t]*$';--> statement-breakpoint
UPDATE "task" SET "input" = btrim(regexp_replace("input", '^[ \t]*head:[ \t]*[0-9a-fA-F]{7,40}[ \t]*(\n|$)', '', 'ng'), E' \t\r\n') WHERE "head" IS NOT NULL;
