CREATE TABLE "slack_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"text" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_inbox_text_length" CHECK (char_length("slack_inbox"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "slack_inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "slack_link_code" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"display_name" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_link_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "slack_link" (
	"owner" text PRIMARY KEY DEFAULT current_setting('app.owner', true) NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_link_slack_user_unique" UNIQUE("team_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "slack_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "slack_inbox" ADD CONSTRAINT "slack_inbox_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_link" ADD CONSTRAINT "slack_link_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_inbox_owner_created_idx" ON "slack_inbox" USING btree ("owner","created_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "slack_inbox" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "slack_link" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
REVOKE ALL ON "slack_link_code" FROM "board_app";--> statement-breakpoint
CREATE FUNCTION "slack_link_code_create"("hash" text, "team" text, "slack_user" text, "name" text, "expires" timestamp with time zone) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	DELETE FROM public.slack_link_code WHERE slack_link_code.expires_at <= now()
		OR (slack_link_code.team_id = "team" AND slack_link_code.slack_user_id = "slack_user");
	INSERT INTO public.slack_link_code (code_hash, team_id, slack_user_id, display_name, expires_at) VALUES ("hash", "team", "slack_user", "name", "expires")
$$;
--> statement-breakpoint
CREATE FUNCTION "slack_link_code_peek"("hash" text) RETURNS TABLE ("team_id" text, "slack_user_id" text, "display_name" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT slack_link_code.team_id, slack_link_code.slack_user_id, slack_link_code.display_name FROM public.slack_link_code
	WHERE slack_link_code.code_hash = "hash" AND slack_link_code.expires_at > now()
$$;
--> statement-breakpoint
CREATE FUNCTION "slack_link_code_redeem"("hash" text) RETURNS TABLE ("team_id" text, "slack_user_id" text, "display_name" text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	DELETE FROM public.slack_link_code WHERE slack_link_code.code_hash = "hash" AND slack_link_code.expires_at > now()
	RETURNING slack_link_code.team_id, slack_link_code.slack_user_id, slack_link_code.display_name
$$;
--> statement-breakpoint
CREATE FUNCTION "slack_owner_for"("team" text, "slack_user" text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT slack_link.owner FROM public.slack_link WHERE slack_link.team_id = "team" AND slack_link.slack_user_id = "slack_user"
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "slack_link_code_create"(text, text, text, text, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "slack_link_code_peek"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "slack_link_code_redeem"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "slack_owner_for"(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "slack_link_code_create"(text, text, text, text, timestamp with time zone) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "slack_link_code_peek"(text) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "slack_link_code_redeem"(text) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "slack_owner_for"(text, text) TO board_app;
