DROP POLICY "tenant" ON "slack_inbox" CASCADE;--> statement-breakpoint
DROP TABLE "slack_inbox" CASCADE;--> statement-breakpoint
DROP TABLE "slack_link_code" CASCADE;--> statement-breakpoint
DROP POLICY "tenant" ON "slack_link" CASCADE;--> statement-breakpoint
DROP TABLE "slack_link" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS "slack_link_code_create"(text, text, text, text, timestamp with time zone);--> statement-breakpoint
DROP FUNCTION IF EXISTS "slack_link_code_peek"(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS "slack_link_code_redeem"(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS "slack_owner_for"(text, text);
