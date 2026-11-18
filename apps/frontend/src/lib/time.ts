import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export const ago = (date: Date | string): string => dayjs(date).fromNow();
export const stamp = (date: Date | string): string => dayjs(date).format('D MMM YYYY, HH:mm');

/** A time of day for a time within the day of `now` ("14:05"), with the date for another day ("18 Nov, 14:05"). */
export const clock = (date: Date | string, now: number = Date.now()): string =>
  dayjs(date).isSame(now, 'day') ? dayjs(date).format('HH:mm') : dayjs(date).format('D MMM, HH:mm');

/** A date as a `datetime-local` input holds it: local time to the minute. */
export const localInputValue = (date: Date | string): string => dayjs(date).format('YYYY-MM-DDTHH:mm');
