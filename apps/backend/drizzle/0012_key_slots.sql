ALTER TABLE "app_user" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "key_slots" jsonb;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_key_all_or_nothing" CHECK (("app_user"."key_id" is null) = ("app_user"."key_slots" is null));