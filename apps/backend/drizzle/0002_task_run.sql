ALTER TABLE "task" ADD COLUMN "lane" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "borrowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "paused_at" timestamp with time zone;