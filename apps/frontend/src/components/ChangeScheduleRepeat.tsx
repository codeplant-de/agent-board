import { formatDuration } from '@agent-board/shared';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { parseRepeatRule } from '../lib/repeat';
import { errorMessage, useTRPC, type Schedule } from '../lib/trpc';
import { RepeatRuleInput } from './RepeatRuleInput';

type PendingCard = 'updated' | 'started' | 'none';

function savedMessage(pending: PendingCard): string {
  switch (pending) {
    case 'updated':
      return 'The waiting card was moved to the new next run.';
    case 'started':
      return 'The waiting card has already started; the new rule applies from the next card.';
    case 'none':
      return 'The schedule has no waiting card; its next card follows the new rule.';
  }
}

function linesOf(schedule: Schedule): string[] {
  if (schedule.everyMs !== null) return [formatDuration(schedule.everyMs)];
  return [schedule.cron ?? '', ...(schedule.moreCrons ?? [])];
}

/** Changes the interval or the cron expressions of a schedule that has a rule of its own; the waiting card moves to the new next run. */
export function ChangeScheduleRepeat({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const trpc = useTRPC();
  const setRule = useMutation(trpc.schedules.setRule.mutationOptions());
  const [lines, setLines] = useState(() => linesOf(schedule));
  const [saved, setSaved] = useState<PendingCard | undefined>(undefined);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rule = parseRepeatRule(lines.join('\n'), timezone);
  const ruleError = 'error' in rule && lines.some((line) => line.trim() !== '') ? rule.error : undefined;
  if (saved !== undefined)
    return (
      <Stack>
        <Alert color="green" variant="light" title="Saved">
          <Text size="sm">{savedMessage(saved)}</Text>
        </Alert>
        <Group justify="flex-end">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    );
  return (
    <Stack>
      <RepeatRuleInput
        lines={lines}
        onChange={(next) => {
          setRule.reset();
          setLines(next);
        }}
        timezone={timezone}
        error={ruleError ?? (setRule.error ? errorMessage(setRule.error) : undefined)}
      />
      {schedule.timezone !== null && schedule.timezone !== timezone && (
        <Text size="xs" c="dimmed">
          The schedule was set in {schedule.timezone}. Saving reads its expressions in {timezone} from now on.
        </Text>
      )}
      <Text size="xs" c="dimmed">
        The interval keeps counting from the schedule&apos;s first run. The waiting card moves to the new next run
        unless a worker already started it.
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={'error' in rule}
          loading={setRule.isPending}
          onClick={() => {
            if ('error' in rule) return;
            setRule.mutate({ id: schedule.id, ...rule }, { onSuccess: ({ pending }) => setSaved(pending) });
          }}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}
