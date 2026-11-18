CREATE TABLE "shared_agents" (
	"owner" text PRIMARY KEY DEFAULT current_setting('app.owner', true) NOT NULL,
	"version" integer NOT NULL,
	"document" text NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_agents_document_sealed" CHECK ("shared_agents"."document" ~ '^abe1[.][A-Za-z0-9_-]{38,}$'),
	CONSTRAINT "shared_agents_version_positive" CHECK ("shared_agents"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "shared_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shared_agents" ADD CONSTRAINT "shared_agents_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant" ON "shared_agents" AS PERMISSIVE FOR ALL TO "board_app" USING (owner = (select current_setting('app.owner', true))) WITH CHECK (owner = (select current_setting('app.owner', true)));