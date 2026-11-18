CREATE TYPE "public"."auth_flow_kind" AS ENUM('oidc', 'saml', 'passkey-login', 'passkey-register', 'passkey-signup');--> statement-breakpoint
CREATE TYPE "public"."session_method" AS ENUM('passkey', 'oidc', 'saml');--> statement-breakpoint
CREATE TABLE "auth_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "auth_flow_kind" NOT NULL,
	"challenge" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkey_name_length" CHECK (char_length("passkey"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "passkey" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"method" "session_method" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "source" "session_method";--> statement-breakpoint
ALTER TABLE "auth_flow" ADD CONSTRAINT "auth_flow_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_flow_expires_idx" ON "auth_flow" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "passkey_owner_idx" ON "passkey" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "session_owner_idx" ON "session" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "passkey" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "session" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));
--> statement-breakpoint
-- Lookups that run before an owner is known, like machine_for_token: they read across owners, so they are SECURITY DEFINER.
-- The write of the sliding expiry is throttled to once an hour per session, because the UI polls every few seconds.
CREATE FUNCTION "session_owner"("hash" text, "ttl_seconds" integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	found_owner text;
BEGIN
	SELECT session.owner INTO found_owner FROM public.session
	WHERE session.token_hash = "hash" AND session.expires_at > now();
	IF found_owner IS NULL THEN
		RETURN NULL;
	END IF;
	UPDATE public.session
	SET last_seen_at = now(), expires_at = now() + make_interval(secs => "ttl_seconds")
	WHERE session.token_hash = "hash" AND session.last_seen_at < now() - interval '1 hour';
	RETURN found_owner;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "passkey_by_credential"("id" text) RETURNS TABLE ("owner" text, "public_key" text, "counter" bigint, "transports" jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT passkey.owner, passkey.public_key, passkey.counter, passkey.transports
	FROM public.passkey WHERE passkey.credential_id = "id"
$$;
--> statement-breakpoint
-- Records a use and refuses a counter that did not advance (a cloned authenticator); a counter that is 0 on both sides is an authenticator that does not count.
CREATE FUNCTION "passkey_used"("id" text, "new_counter" bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	WITH updated AS (
		UPDATE public.passkey SET counter = "new_counter", last_used_at = now()
		WHERE passkey.credential_id = "id"
			AND ("new_counter" > passkey.counter OR ("new_counter" = 0 AND passkey.counter = 0))
		RETURNING 1
	)
	SELECT EXISTS (SELECT 1 FROM updated)
$$;
--> statement-breakpoint
CREATE FUNCTION "username_taken"("name" text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	SELECT EXISTS (SELECT 1 FROM public.app_user WHERE app_user.username = "name")
		OR EXISTS (SELECT 1 FROM public.passkey WHERE passkey.owner = "name")
$$;
--> statement-breakpoint
CREATE FUNCTION "purge_auth"() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	WITH sessions AS (DELETE FROM public.session WHERE session.expires_at <= now() RETURNING 1),
		flows AS (DELETE FROM public.auth_flow WHERE auth_flow.expires_at <= now() RETURNING 1)
	SELECT (SELECT count(*) FROM sessions)::integer + (SELECT count(*) FROM flows)::integer
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "session_owner"(text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "passkey_by_credential"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "passkey_used"(text, bigint) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "username_taken"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "purge_auth"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "session_owner"(text, integer) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "passkey_by_credential"(text) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "passkey_used"(text, bigint) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "username_taken"(text) TO board_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "purge_auth"() TO board_app;
