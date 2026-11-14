ALTER TYPE "public"."note_author" ADD VALUE 'server';--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_schedule_fk";--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "questions" SET DATA TYPE text USING "questions"::text;--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "answers" SET DATA TYPE text USING "answers"::text;--> statement-breakpoint
ALTER TABLE "transcript_event" ALTER COLUMN "data" SET DATA TYPE text USING "data"::text;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "preview" text;--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "labels";