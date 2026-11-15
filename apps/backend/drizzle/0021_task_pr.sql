ALTER TABLE "task" ADD COLUMN "pr" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_pr_sealed" CHECK ("task"."pr" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');