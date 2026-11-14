import { Text, type TextProps } from '@mantine/core';
import { useEffect, useState } from 'react';
import { liveness } from '../lib/liveness';

/** "active 12s ago", re-rendered every second by itself, so the card or panel around it does not re-render. */
export function LivenessText({
  lastActiveAt,
  span = false,
  ...props
}: TextProps & { lastActiveAt: Date | string | null; span?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { text, color } = liveness(lastActiveAt, now);
  return (
    <Text span={span} fw={500} c={color} {...props}>
      {text}
    </Text>
  );
}
