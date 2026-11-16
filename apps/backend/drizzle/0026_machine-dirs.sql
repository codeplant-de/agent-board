ALTER TABLE "machine" ADD COLUMN "dirs" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "dirs_index" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "dirs_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_dirs_sealed" CHECK ("machine"."dirs" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_dirs_index_blind" CHECK ("machine"."dirs_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$');