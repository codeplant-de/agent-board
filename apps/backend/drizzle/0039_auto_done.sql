CREATE TYPE "public"."task_actor" AS ENUM('user', 'agent', 'machine');--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "auto_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "auto_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "moved_by" "task_actor";