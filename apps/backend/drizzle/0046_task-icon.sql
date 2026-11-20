ALTER TABLE "schedule" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_icon_sealed" CHECK ("schedule"."icon" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_icon_sealed" CHECK ("task"."icon" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');