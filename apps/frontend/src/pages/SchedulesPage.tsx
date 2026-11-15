import { describeRule, INVALID_VALUE, runsLeft } from '@agent-board/shared';
import { ActionIcon, Anchor, Badge, Code, Group, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconPlayerPause, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ago, stamp } from '../lib/time';
import { errorMessage, POLL_MS, useTRPC, type Schedule as ScheduleRow } from '../lib/trpc';

function ScheduleActions({ schedule }: { schedule: ScheduleRow }) {
  const trpc = useTRPC();
  const setPaused = useMutation(trpc.schedules.setPaused.mutationOptions());
  const remove = useMutation(trpc.schedules.remove.mutationOptions());
  const confirmRemove = () =>
    modals.openConfirmModal({
      title: `Delete "${schedule.title}"?`,
      children: (
        <Text size="sm">
          The waiting run is removed and nothing repeats any more. Tasks that already ran stay on the board.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ id: schedule.id }),
    });
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      {!schedule.ended && (
        <Tooltip label={schedule.paused ? 'Resume' : 'Pause'}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={schedule.paused ? 'Resume' : 'Pause'}
            loading={setPaused.isPending}
            onClick={() => setPaused.mutate({ id: schedule.id, paused: !schedule.paused })}
          >
            {schedule.paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip label="Delete">
        <ActionIcon variant="subtle" color="red" aria-label="Delete" loading={remove.isPending} onClick={confirmRemove}>
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function ScheduleRowView({ schedule }: { schedule: ScheduleRow }) {
  return (
    <Table.Tr style={{ opacity: schedule.ended ? 0.55 : undefined }}>
      <Table.Td maw={320}>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" truncate>
            {schedule.title}
          </Text>
          {schedule.paused && (
            <Badge size="xs" color="yellow" variant="light">
              paused
            </Badge>
          )}
          {schedule.ended && (
            <Badge size="xs" color="gray" variant="light">
              ended
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {schedule.input}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{schedule.invalid.includes('everyMs') ? INVALID_VALUE : describeRule(schedule)}</Text>
      </Table.Td>
      <Table.Td>
        {schedule.nextRunAt ? (
          <Text size="sm">
            {stamp(schedule.nextRunAt)}{' '}
            <Text span size="xs" c="dimmed">
              {ago(schedule.nextRunAt)}
            </Text>
          </Text>
        ) : (
          <Text size="sm" c={schedule.occurrenceTaskId ? undefined : 'dimmed'}>
            {schedule.occurrenceTaskId ? 'now' : '-'}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">
          {schedule.invalid.includes('remaining')
            ? INVALID_VALUE
            : (runsLeft(schedule) ?? (schedule.until ? `until ${stamp(schedule.until)}` : 'forever'))}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c={schedule.machine ? undefined : 'dimmed'}>
          {schedule.machine ?? 'any'}
        </Text>
      </Table.Td>
      <Table.Td>
        {schedule.occurrenceTaskId ? (
          <Anchor component={Link} to={`/t/${schedule.occurrenceTaskId}`} size="sm">
            Next card
          </Anchor>
        ) : (
          <Text size="sm" c="dimmed">
            -
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <ScheduleActions schedule={schedule} />
      </Table.Td>
    </Table.Tr>
  );
}

export function SchedulesPage() {
  const trpc = useTRPC();
  const schedules = useQuery({ ...trpc.schedules.list.queryOptions(), refetchInterval: POLL_MS });
  const rows = schedules.data ?? [];
  return (
    <Stack maw={1100} mx="auto">
      <Title order={3}>Schedules</Title>
      <Text size="sm" c="dimmed">
        Each schedule keeps one pending card on the board; the next one appears when that card is started, moved or
        closed. Runs missed while nothing took the card are skipped. Make one with New task, When: Repeating, or{' '}
        <Code>board schedule --every</Code>.
      </Text>
      {schedules.error && <Text c="red">{errorMessage(schedules.error)}</Text>}
      <Paper withBorder style={{ overflowX: 'auto' }}>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed" p="md">
            No schedules yet.
          </Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Rule</Table.Th>
                <Table.Th>Next run</Table.Th>
                <Table.Th>Runs left</Table.Th>
                <Table.Th>Machine</Table.Th>
                <Table.Th>Card</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((schedule) => (
                <ScheduleRowView key={schedule.id} schedule={schedule} />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
