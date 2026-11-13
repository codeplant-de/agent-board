import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export const ago = (date: Date | string): string => dayjs(date).fromNow();
export const stamp = (date: Date | string): string => dayjs(date).format('D MMM YYYY, HH:mm');
