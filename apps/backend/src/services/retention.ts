/** Closed tasks keep their transcripts this long. */
export const TRANSCRIPT_RETENTION_DAYS = 14;

/** A task untouched in Done this long is closed, except tasks with a key (a script's reviews) and those of the removed intake. */
export const DONE_ARCHIVE_DAYS = 7;

export const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60_000);

/** Tasks with a key and those of the removed intake stay open in Done, so their transcripts go after this long untouched. */
export const DONE_TRANSCRIPT_DAYS = 28;
