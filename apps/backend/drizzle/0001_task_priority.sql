CREATE TYPE "public"."task_priority" AS ENUM('urgent', 'high', 'normal', 'low');--> statement-breakpoint
DROP INDEX "task_status_position_idx";--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "priority" "task_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
CREATE INDEX "task_status_priority_position_idx" ON "task" USING btree ("status","priority","position");