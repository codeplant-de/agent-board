ALTER TABLE "task" ADD COLUMN "watches" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "watch_stops" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_watches_sealed" CHECK ("task"."watches" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');