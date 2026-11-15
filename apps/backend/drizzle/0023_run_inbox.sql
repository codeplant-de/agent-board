ALTER TABLE "note" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "queued" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "inbox_read" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "stop_message_id" text;