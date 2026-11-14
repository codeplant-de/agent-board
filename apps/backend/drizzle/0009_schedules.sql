CREATE TABLE "schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"input" text NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"machine" text,
	"workdir" text,
	"every_ms" bigint,
	"cron" text,
	"timezone" text,
	"anchor_at" timestamp with time zone NOT NULL,
	"last_occurrence_at" timestamp with time zone,
	"remaining" integer,
	"until" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"occurrence_task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_occurrence_task_id_task_id_fk" FOREIGN KEY ("occurrence_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedule"("id") ON DELETE set null ON UPDATE no action;