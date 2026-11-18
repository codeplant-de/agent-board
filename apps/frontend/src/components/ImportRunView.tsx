import { Button, Group, List, Progress, Stack, Text } from '@mantine/core';
import type { ImportRun } from './useImportRun';

interface Props {
  run: ImportRun;
  onCancel: () => void;
  /** The username the import runs as, and the one the file was exported under. */
  owner: string;
  fileOwner: string;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Progress while an import runs, and what it did when it stopped. Renders nothing before it starts. */
export function ImportRunView({ run, onCancel, owner, fileOwner }: Props) {
  if (run.status === 'idle') return null;
  if (run.status === 'running') {
    const { bytesRead, size } = run.progress;
    const percent = size === 0 ? 0 : Math.min(100, Math.round((bytesRead / size) * 100));
    return (
      <Stack gap="xs">
        <Progress value={percent} aria-label="Import progress" />
        <Group justify="space-between">
          <Text size="sm">Importing, {percent}% of the file read</Text>
          <Button size="xs" variant="default" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    );
  }
  if (run.status === 'cancelled')
    return (
      <Text size="sm">
        The import was cancelled. Rows sent so far stay on the board; importing the file again skips them.
      </Text>
    );
  if (run.status === 'failed')
    return (
      <Text size="sm" c="red">
        The import stopped: {run.message}. Rows sent so far stay on the board; importing the file again skips them.
      </Text>
    );
  const { inserted, existing, invalid, orphaned, unreadable } = run.totals;
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Import finished
      </Text>
      <List size="sm" spacing={2}>
        <List.Item>{plural(inserted, 'row added', 'rows added')}</List.Item>
        <List.Item>
          {existing} already on this board or held by another account on this server, left as they are
        </List.Item>
        <List.Item>{invalid} not well formed, skipped</List.Item>
        <List.Item>{orphaned} skipped because their task, run or schedule to run after is not on the board</List.Item>
      </List>
      {inserted === 0 && existing > 0 && fileOwner !== owner && (
        <Text size="sm">
          The account <strong>{fileOwner}</strong> on this server probably still holds these rows: ids and machine
          tokens are unique across the server. Export again if needed, delete that account, then import the file again.
        </Text>
      )}
      {unreadable > 0 && (
        <Text size="sm">
          {plural(unreadable, 'value', 'values')} could not be opened and {unreadable === 1 ? 'was' : 'were'} copied as
          they are.
        </Text>
      )}
    </Stack>
  );
}
