CREATE TABLE "transcript_event" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"parent" text,
	"data" jsonb NOT NULL,
	"output" text,
	"output_size" integer,
	CONSTRAINT "transcript_event_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "transcript_run" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"machine" text NOT NULL,
	"session_id" text,
	"resumed" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_run_id_transcript_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."transcript_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_run" ADD CONSTRAINT "transcript_run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_run_task_idx" ON "transcript_run" USING btree ("task_id","started_at");