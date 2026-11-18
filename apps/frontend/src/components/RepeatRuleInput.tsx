import { MAX_SCHEDULE_CRONS } from '@agent-board/shared';
import { ActionIcon, Button, Stack, Text, TextInput } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { isInterval } from '../lib/repeat';

interface Props {
  /** The rule as typed, one row each: an interval, or cron expressions. Never empty. */
  lines: readonly string[];
  onChange: (lines: string[]) => void;
  /** The time zone the expressions are read in. */
  timezone: string;
  error?: string | undefined;
}

/** The rule of a repeat: one row for an interval or a cron expression, and a row for each further cron expression. */
export function RepeatRuleInput({ lines, onChange, timezone, error }: Props) {
  const [first = '', ...others] = lines;
  const canAdd = first.trim() !== '' && !isInterval(first) && lines.length < MAX_SCHEDULE_CRONS;
  const setLine = (index: number, value: string) => onChange(lines.map((line, i) => (i === index ? value : line)));
  return (
    <Stack gap={6}>
      <TextInput
        label="Repeat"
        required
        placeholder="2h, or a cron expression such as 0 9 * * 1-5"
        value={first}
        onChange={(e) => setLine(0, e.currentTarget.value)}
        description={`An interval (30m, 2h, 1d, 1w) or 5 cron fields, read in ${timezone}. With cron expressions you can add more (up to ${MAX_SCHEDULE_CRONS}); the schedule runs whenever any of them matches`}
      />
      {others.map((line, offset) => (
        <TextInput
          key={offset}
          aria-label={`Cron expression ${offset + 2}`}
          placeholder="Another cron expression, such as 0 17 * * 5"
          value={line}
          onChange={(e) => setLine(offset + 1, e.currentTarget.value)}
          rightSection={
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Remove cron expression ${offset + 2}`}
              onClick={() => onChange(lines.filter((_, i) => i !== offset + 1))}
            >
              <IconX size={14} />
            </ActionIcon>
          }
        />
      ))}
      {canAdd && (
        <Button
          variant="subtle"
          size="compact-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onChange([...lines, ''])}
        >
          Add cron expression
        </Button>
      )}
      {error !== undefined && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
