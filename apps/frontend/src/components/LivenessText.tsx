import { Text, type TextProps } from '@mantine/core';
import { liveness } from '../lib/liveness';
import { useNow } from '../lib/useNow';

/** "active 12s ago", re-rendered every second by itself, so the card or panel around it does not re-render. */
export function LivenessText({
  lastActiveAt,
  span = false,
  ...props
}: TextProps & { lastActiveAt: Date | string | null; span?: boolean }) {
  const { text, color } = liveness(lastActiveAt, useNow(1000));
  return (
    <Text span={span} fw={500} c={color} {...props}>
      {text}
    </Text>
  );
}
