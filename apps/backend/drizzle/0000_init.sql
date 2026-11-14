CREATE TYPE "public"."next_run" AS ENUM('fresh', 'resume');--> statement-breakpoint
CREATE TYPE "public"."note_author" AS ENUM('agent', 'user', 'system');--> statement-breakpoint
CREATE TYPE "public"."note_kind" AS ENUM('comment', 'question', 'answer', 'event');--> statement-breakpoint
CREATE TYPE "public"."task_creator" AS ENUM('intake', 'user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'running', 'needs-me', 'done');--> statement-breakpoint
CREATE TABLE "label" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine" (
	"name" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "machine_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"author" "note_author" NOT NULL,
	"kind" "note_kind" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"questions" jsonb,
	"answers" jsonb,
	"question_note_id" text,
	"by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"input" text DEFAULT '' NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"position" double precision NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"machine" text,
	"session_id" text,
	"next" "next_run" DEFAULT 'fresh' NOT NULL,
	"open_question_note_id" text,
	"dedupe_key" text,
	"parent_id" text,
	"created_by" "task_creator" DEFAULT 'user' NOT NULL,
	"proposed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_id_task_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_task_created_idx" ON "note" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_status_position_idx" ON "task" USING btree ("status","position");