/** Closed tasks keep their transcripts this long. */
export const TRANSCRIPT_RETENTION_DAYS = 14;

/** A task untouched in Done this long is closed, except intake's. */
export const DONE_ARCHIVE_DAYS = 14;

export const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60_000);

/** Intake's tasks stay open in Done, so their transcripts go after this long untouched. */
export const DONE_TRANSCRIPT_DAYS = 28;
