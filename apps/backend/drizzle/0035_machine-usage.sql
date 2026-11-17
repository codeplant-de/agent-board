ALTER TABLE "machine" ADD COLUMN "usage" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "usage_index" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "usage_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_usage_sealed" CHECK ("machine"."usage" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_usage_index_blind" CHECK ("machine"."usage_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$');