ALTER TABLE "schedule" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_agent_sealed" CHECK ("schedule"."agent" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_agent_sealed" CHECK ("task"."agent" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');