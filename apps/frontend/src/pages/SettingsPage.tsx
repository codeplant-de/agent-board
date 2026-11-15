import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { INVALID_VALUE, MACHINE_NAME_RULE, type Keys } from '@agent-board/shared';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { KeyError } from '../crypto/kdf';
import { exportDataKey, replacePassphrase, type StoredKey } from '../crypto/keySlots';
import { useKeys } from '../crypto/KeyContext';
import { PASSPHRASE_ADVICE, passphraseProblem, samePassphrase } from '../crypto/passphrase';
import { PassphraseModal } from '../crypto/PassphraseModal';
import {
  isNotificationSupported,
  readDesktopNotificationsPreference,
  subscribeToDesktopNotificationsPreference,
  writeDesktopNotificationsPreference,
} from '../lib/desktopNotifications';
import { ago } from '../lib/time';
import { errorMessage, useTRPC } from '../lib/trpc';

/**
 * The slots the board stores, read as the key this browser is using: the owner and key id are the browser's, not the ones the
 * board reports, so a key that unwraps is shown or re-wrapped only when it is the one in use.
 */
function asHeld(stored: StoredKey, keys: Keys): StoredKey {
  return { ...stored, keyId: keys.keyId };
}

interface Enrolment {
  name: string;
  token: string | null;
  dataKey: string;
}

const envLines = ({ token, dataKey }: Enrolment): string[] => [
  ...(token === null ? [] : [`AGENT_BOARD_TOKEN=${token}`]),
  `AGENT_BOARD_DATA_KEY=${dataKey}`,
];

function Machines() {
  const trpc = useTRPC();
  const machines = useQuery(trpc.machines.list.queryOptions());
  const issue = useMutation(trpc.machines.issue.mutationOptions());
  const revoke = useMutation(trpc.machines.revoke.mutationOptions());
  const keys = useKeys();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<Enrolment | null>(null);
  const [asking, setAsking] = useState<{ name: string; issuing: boolean } | null>(null);

  // The passphrase is checked before a token is issued, so a wrong one leaves the machine's old token alone.
  const enrol = async (passphrase: string) => {
    const stored = await queryClient.fetchQuery(trpc.keys.get.queryOptions());
    if (!asking || !keys || !stored) throw new KeyError('The key is not available. Reload the page.');
    const dataKey = await exportDataKey({ owner: keys.owner, stored: asHeld(stored, keys), passphrase });
    const token = asking.issuing ? (await issue.mutateAsync({ name: asking.name })).token : null;
    setIssued({ name: asking.name, token, dataKey });
    setName('');
    setAsking(null);
  };
  const create = (target: string) => setAsking({ name: target, issuing: true });
  // A new token for a machine that has one stops the old one at once.
  const issueFor = (target: string) =>
    machines.data?.some((m) => m.name === target)
      ? modals.openConfirmModal({
          title: `New token for ${target}?`,
          children: (
            <Text size="sm">
              The old token stops working at once; put the new one on {target} or its dispatcher and intake fail.
            </Text>
          ),
          labels: { confirm: 'New token', cancel: 'Cancel' },
          confirmProps: { color: 'red' },
          onConfirm: () => create(target),
        })
      : create(target);

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Worker machines</Title>
          <Text size="sm" c="dimmed">
            Each machine that runs <Code>dispatch</Code> and <Code>intake</Code> gets a token. Its name must match{' '}
            <Code>machine</Code> in its config.json (default: the host name).
          </Text>
        </div>
        {asking && (
          <PassphraseModal
            title={asking.issuing ? `Token for ${asking.name}` : `Data key for ${asking.name}`}
            description={
              <>
                The machine needs your data key to read and write the board. Enter your passphrase to show it
                {asking.issuing ? ' with the new token' : ''}.
              </>
            }
            confirmLabel={asking.issuing ? 'Create token' : 'Show data key'}
            onClose={() => setAsking(null)}
            onSubmit={enrol}
          />
        )}
        {issued && (
          <Alert
            color="teal"
            icon={<IconKey size={18} />}
            title={`${issued.token === null ? 'Data key' : 'Token and data key'} for ${issued.name}, shown once`}
            withCloseButton
            onClose={() => setIssued(null)}
          >
            <Stack gap="xs">
              <Text size="sm">
                Put {issued.token === null ? 'it' : 'both lines'} in <Code>~/.config/agent-board/env</Code> (mode 600)
                on that machine. The data key opens everything on the board: keep it as secret as the passphrase.
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Code block style={{ flex: 1, overflowX: 'auto' }}>
                  {envLines(issued).join('\n')}
                </Code>
                <CopyButton value={envLines(issued).join('\n')}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy'}>
                      <ActionIcon variant="default" onClick={copy} size="lg">
                        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          </Alert>
        )}
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Last seen</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(machines.data ?? []).map((m) => (
              <Table.Tr key={m.name}>
                <Table.Td>
                  <Group gap="xs">
                    <Text size="sm">{m.shown}</Text>
                    {m.revokedAt && (
                      <Badge size="xs" color="red" variant="light">
                        revoked
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {m.lastSeenAt ? ago(m.lastSeenAt) : 'never'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    {m.shown !== INVALID_VALUE && (
                      <Button size="xs" variant="default" onClick={() => issueFor(m.name)}>
                        New token
                      </Button>
                    )}
                    {!m.revokedAt && m.shown !== INVALID_VALUE && (
                      <Button size="xs" variant="default" onClick={() => setAsking({ name: m.name, issuing: false })}>
                        Show data key
                      </Button>
                    )}
                    {!m.revokedAt && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          modals.openConfirmModal({
                            title: m.shown === INVALID_VALUE ? 'Revoke this machine’s token?' : `Revoke ${m.shown}?`,
                            children: (
                              <Text size="sm">Its dispatcher and intake stop working until it gets a new token.</Text>
                            ),
                            labels: { confirm: 'Revoke', cancel: 'Cancel' },
                            confirmProps: { color: 'red' },
                            onConfirm: () => revoke.mutate({ name: m.name }),
                          })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group align="flex-end">
          <TextInput
            label="Add a machine"
            description={`A name of ${MACHINE_NAME_RULE}`}
            placeholder="laptop"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button onClick={() => issueFor(name.trim())} disabled={!name.trim()}>
            Create token
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function Encryption() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useKeys();
  const replaceSlots = useMutation(trpc.keys.replaceSlots.mutationOptions());
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = next === '' ? null : passphraseProblem(next);
  const mismatch = again !== '' && !samePassphrase(again, next);
  const ready = current !== '' && next !== '' && problem === null && samePassphrase(again, next);

  const change = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await queryClient.fetchQuery(trpc.keys.get.queryOptions());
      if (!keys || !stored) throw new KeyError('The key is not available. Reload the page.');
      const { slots } = await replacePassphrase({
        owner: keys.owner,
        stored: asHeld(stored, keys),
        secret: { kind: 'passphrase', passphrase: current },
        newPassphrase: next,
      });
      await replaceSlots.mutateAsync({ keyId: keys.keyId, slots });
      setCurrent('');
      setNext('');
      setAgain('');
      notifications.show({ color: 'teal', message: 'Passphrase changed. The recovery key still works.' });
    } catch (err) {
      setError(err instanceof KeyError ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Encryption</Title>
          <Text size="sm" c="dimmed">
            Your board is encrypted with a key only you hold
            {keys ? (
              <>
                {' '}
                (key id <Code>{keys.keyId}</Code>)
              </>
            ) : null}
            . {PASSPHRASE_ADVICE}
          </Text>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void change();
          }}
        >
          <Stack maw={360}>
            <PasswordInput
              label="Current passphrase"
              value={current}
              onChange={(event) => setCurrent(event.currentTarget.value)}
              error={error}
              autoComplete="current-password"
            />
            <PasswordInput
              label="New passphrase"
              value={next}
              onChange={(event) => setNext(event.currentTarget.value)}
              error={problem}
              autoComplete="new-password"
            />
            <PasswordInput
              label="New passphrase again"
              value={again}
              onChange={(event) => setAgain(event.currentTarget.value)}
              error={mismatch ? 'The passphrases differ.' : null}
              autoComplete="new-password"
            />
            <Group>
              <Button type="submit" disabled={!ready} loading={busy}>
                Change passphrase
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Paper>
  );
}

function DesktopNotifications() {
  const on = useSyncExternalStore(subscribeToDesktopNotificationsPreference, readDesktopNotificationsPreference);
  const supported = isNotificationSupported();
  const [permission, setPermission] = useState(() => (supported ? Notification.permission : 'denied'));
  const blocked = supported && permission === 'denied';

  // The permission prompt needs the click that calls this.
  const toggle = async (next: boolean) => {
    if (!next) return writeDesktopNotificationsPreference(false);
    const result = await Notification.requestPermission();
    setPermission(result);
    writeDesktopNotificationsPreference(result === 'granted');
  };

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Desktop notifications</Title>
          <Text size="sm" c="dimmed">
            Get a notification when a task needs you. It works while a board tab is open, in the background too.
          </Text>
        </div>
        <Switch
          label="Notify me when a task needs me"
          checked={on && permission === 'granted'}
          disabled={!supported || blocked}
          onChange={(event) => void toggle(event.currentTarget.checked)}
        />
        {!supported && (
          <Text size="sm" c="dimmed">
            This browser does not offer notifications here. They need https or localhost.
          </Text>
        )}
        {blocked && (
          <Text size="sm" c="red">
            The browser blocks notifications for this site. Allow them in the site settings, then reload the page.
          </Text>
        )}
        {on && permission === 'granted' && (
          <Group>
            <Button
              size="xs"
              variant="default"
              onClick={() => new Notification('Agent Board', { body: 'Notifications work.', icon: '/favicon.svg' })}
            >
              Send a test
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

export function SettingsPage() {
  return (
    <Stack maw={900} mx="auto">
      <Title order={3}>Settings</Title>
      <Machines />
      <DesktopNotifications />
      <Encryption />
    </Stack>
  );
}
