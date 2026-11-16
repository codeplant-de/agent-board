ALTER TABLE "task" ADD COLUMN "home_workdir" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_home_workdir_sealed" CHECK ("task"."home_workdir" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
-- A claim sets last_active_at and nothing clears it, and a worker rewrites `workdir` only in a claimed run. So a task without
-- either mark has its original directory, and only such a task can be backfilled.
UPDATE "task" SET "home_workdir" = "workdir" WHERE "workdir" IS NOT NULL AND "last_active_at" IS NULL AND "session_id" IS NULL;
