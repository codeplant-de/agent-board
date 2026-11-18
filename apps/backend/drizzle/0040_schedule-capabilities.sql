ALTER TABLE "schedule" ADD COLUMN "more_crons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "after_schedule_id" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "after_delay_ms" bigint;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "max_concurrent" integer;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "occurrence_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_after_fk" FOREIGN KEY ("owner","after_schedule_id") REFERENCES "public"."schedule"("owner","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_one_rule" CHECK (("schedule"."every_ms" is not null)::int + ("schedule"."cron" is not null)::int + ("schedule"."after_schedule_id" is not null)::int = 1);--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_after_delay" CHECK (("schedule"."after_schedule_id" is null) = ("schedule"."after_delay_ms" is null));