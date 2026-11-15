CREATE TYPE "public"."pr_state" AS ENUM('open', 'merged', 'closed');--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pr_state" "pr_state";