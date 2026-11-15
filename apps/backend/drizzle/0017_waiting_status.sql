ALTER TYPE "public"."task_status" ADD VALUE 'waiting' BEFORE 'needs-me';--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "wake_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "wait_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "woken_at" timestamp with time zone;