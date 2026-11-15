ALTER TABLE "note" ADD COLUMN "suggestion" text;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_suggestion_sealed" CHECK ("note"."suggestion" ~ '^abe1[.][A-Za-z0-9_-]{38,}$');--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_suggestion_agent_comment" CHECK ("note"."suggestion" is null or ("note"."author"::text = 'agent' and "note"."kind" = 'comment'));