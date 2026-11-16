-- Agent proposals wait in Backlog now, not Needs me. Move the open ones, in their old order, to the bottom of their owner's Backlog.
-- Dynamic SQL, run only when there is something to move: a fresh database applies 0007 (which adds 'backlog') in this same
-- transaction, and Postgres refuses to use a new enum value there, even in a statement that touches no row.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "task" WHERE "proposed" AND "status" = 'needs-me' AND NOT "closed") THEN
		EXECUTE $sql$
			WITH moved AS (
				SELECT "id", row_number() OVER (PARTITION BY "owner" ORDER BY "priority", "position") AS "n"
				FROM "task"
				WHERE "proposed" AND "status" = 'needs-me' AND NOT "closed"
			)
			UPDATE "task" SET
				"status" = 'backlog',
				"open_question_note_id" = NULL,
				"updated_at" = now(),
				"position" = coalesce((SELECT max(b."position") FROM "task" b WHERE b."owner" = "task"."owner" AND b."status" = 'backlog'), -1) + moved."n"
			FROM moved WHERE "task"."id" = moved."id"
		$sql$;
	END IF;
END
$$;
