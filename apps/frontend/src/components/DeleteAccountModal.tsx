import { Alert, Button, Code, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { useLock } from '../crypto/KeyContext';
import { useSubmit } from '../crypto/useSubmit';
import type { AccountSummary } from '../lib/boardExport';
import { clearBoardPrefs } from '../lib/boardPrefs';
import { useRawTRPCClient } from '../lib/trpc';
import { useAccountDeleted } from './AccountDeletedContext';

interface Props {
  username: string;
  summary: AccountSummary;
  onClose: () => void;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function DeleteAccountModal({ username, summary, onClose }: Props) {
  const client = useRawTRPCClient();
  const lock = useLock();
  const markDeleted = useAccountDeleted();
  const [typed, setTyped] = useState('');
  const matches = typed === username;
  const { busy, error, submit } = useSubmit(async () => {
    await client.account.delete.mutate({ username: typed });
    // The key store is cleared as Lock does it. The screen replaces the app first, so nothing asks the board again meanwhile.
    const cleared = lock?.();
    markDeleted();
    clearBoardPrefs();
    await cleared;
  }, matches);
  return (
    <Modal opened onClose={onClose} title="Delete your account and all its data" size="lg" closeOnClickOutside={!busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack>
          <Text size="sm">This deletes from the board:</Text>
          <List size="sm" spacing={2}>
            <List.Item>{count(summary.tasks, 'task', 'tasks')}</List.Item>
            <List.Item>{count(summary.schedules, 'schedule', 'schedules')}</List.Item>
            <List.Item>{count(summary.notes, 'note', 'notes')}</List.Item>
            <List.Item>{count(summary.machines, 'machine', 'machines')}, with their tokens</List.Item>
            <List.Item>
              {count(summary.transcriptRuns, 'transcript', 'transcripts')} (
              {count(summary.transcriptEvents, 'event', 'events')})
            </List.Item>
            <List.Item>Your key slots: no passphrase or recovery key opens anything afterwards.</List.Item>
          </List>
          {summary.running > 0 && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Runs are in progress">
              <Text size="sm">
                {count(summary.running, 'task is', 'tasks are')} running. Those runs keep going on their machines but
                can no longer report to the board.
              </Text>
            </Alert>
          )}
          <Text size="sm">Export your data first if you may want it back. A deleted account cannot be restored.</Text>
          <Text size="sm" fw={500}>
            What the board cannot delete:
          </Text>
          <List size="sm" spacing={2}>
            <List.Item>Your sign-in. It belongs to the login proxy in front of the board.</List.Item>
            <List.Item>
              The files on your worker machines: <Code>~/.config/agent-board</Code>, state and logs, and Claude&rsquo;s
              session files.
            </List.Item>
            <List.Item>The operator&rsquo;s database backups, until they expire.</List.Item>
          </List>
          <TextInput
            label={
              <>
                Type <Code>{username}</Code> to confirm
              </>
            }
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            error={error}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" color="red" disabled={!matches} loading={busy}>
              Delete everything
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
