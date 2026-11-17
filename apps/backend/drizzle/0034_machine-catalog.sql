ALTER TABLE "machine" ADD COLUMN "catalog" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "catalog_index" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "catalog_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_catalog_sealed" CHECK ("machine"."catalog" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_catalog_index_blind" CHECK ("machine"."catalog_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$');