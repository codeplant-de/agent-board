import { decodeDataKey, deriveKeys, machineUsageBinding, type KeySetup, type Keys } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyProvider } from '../crypto/KeyProvider';
import { createKeySetup } from '../crypto/keySlots';
import { SettingsPage } from './SettingsPage';
import { openAs, sealerFor } from '../lib/contexts';
import { openMachines } from '../lib/opening';

const TITLE = { field: 'title', context: 'task:abc' } as const;

const revoke = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const issue = vi.hoisted(() => vi.fn(async (_: unknown) => ({ token: 'abm_secret-token' })));
interface MachineRow {
  name: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  clientVersion?: string | null;
  clientStatus?: 'current' | 'outdated' | 'incompatible' | 'unknown';
  usage?: string | null;
  usageUpdatedAt?: string | null;
}
const machines = vi.hoisted(() => ({ current: [] as MachineRow[], failure: null as Error | null }));
const stored = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../lib/trpc', () => ({
  errorMessage: String,
  useTRPC: () => ({
    me: {
      queryOptions: () => ({
        queryKey: ['me'],
        queryFn: async () => ({ username: 'jascha', keyId: (stored.current as KeySetup).keyId }),
      }),
    },
    keys: {
      get: { queryOptions: () => ({ queryKey: ['keys'], queryFn: async () => stored.current }) },
      replaceSlots: { mutationOptions: () => ({ mutationFn: async () => null }) },
    },
    machines: {
      list: {
        queryOptions: () => ({
          queryKey: ['machines'],
          queryFn: async () => {
            if (machines.failure) throw machines.failure;
            return openMachines(held, machines.current as never);
          },
        }),
      },
      advertisedCli: { queryOptions: () => ({ queryKey: ['advertisedCli'], queryFn: async () => '0.7.0' }) },
      issue: { mutationOptions: () => ({ mutationFn: issue }) },
      revoke: { mutationOptions: () => ({ mutationFn: revoke }) },
    },
  }),
}));

const PASSPHRASE = 'correct horse battery staple';
let setup: KeySetup;
let held: Keys;
let sealedByBrowser: string;

function renderPage() {
  render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <KeyProvider keys={held} lock={async () => undefined}>
            <SettingsPage />
          </KeyProvider>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

const VALUE: Record<string, string> = {
  AGENT_BOARD_TOKEN: 'abm_[A-Za-z0-9_-]+',
  AGENT_BOARD_DATA_KEY: 'abk1_[A-Za-z0-9_-]{43}',
};

/** The value of the line `NAME=value` shown on the page. */
const shownLine = (name: string): string | undefined =>
  (document.body.textContent ?? '').match(new RegExp(`${name}=(${VALUE[name]})`))?.[1];

beforeAll(async () => {
  const made = await createKeySetup({ owner: 'jascha', passphrase: PASSPHRASE, kdf: { m: 8192, t: 1, p: 1 } });
  setup = made.setup;
  held = made.keys;
  sealedByBrowser = await sealerFor(made.keys)(TITLE, 'sealed in the browser');
});

beforeEach(() => {
  issue.mockClear();
  revoke.mockClear();
  stored.current = setup;
  machines.failure = null;
  machines.current = [
    { name: 'laptop', lastSeenAt: null, revokedAt: null, clientVersion: '0.7.0', clientStatus: 'current' },
  ];
});

async function askFor(button: string, passphrase: string) {
  await userEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Passphrase', { selector: 'input' }), passphrase);
  await userEvent.click(within(dialog).getByRole('button', { name: button }));
}

describe('a machine whose token carries a name the browser no longer accepts', () => {
  // Names used to be any 1 to 64 characters. The token still works, so it must stay revocable.
  const odd = 'old laptop (the 2019 one) with a very long and unusual name that issue once accepted';

  it('is shown as a placeholder, never as text, and can still be revoked under its raw name', async () => {
    machines.current = [{ name: odd, lastSeenAt: null, revokedAt: null }];
    renderPage();
    expect(await screen.findByText('(invalid)')).toBeInTheDocument();
    expect(screen.queryByText(odd)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New token' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show data key' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain('old laptop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revoke).toHaveBeenCalled());
    expect(revoke.mock.calls[0]?.[0]).toEqual({ name: odd });
  });

  it('shows a name of the shape as it is, with every action', async () => {
    renderPage();
    expect(await screen.findByText('laptop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});

describe('a machines list that does not load', () => {
  it('shows the error, not an empty table', async () => {
    machines.failure = new Error('board is locked');
    renderPage();
    expect(await screen.findByText(/Could not load machines: .*board is locked/)).toBeInTheDocument();
    expect(screen.queryByText('laptop')).not.toBeInTheDocument();
  });
});

describe('machine enrolment', () => {
  it('shows the token and a data key that opens what the browser sealed, after the passphrase', async () => {
    renderPage();
    await userEvent.type(await screen.findByLabelText('Add a machine'), 'desktop');
    await askFor('Create token', PASSPHRASE);
    await screen.findByText(/shown once/);
    expect(issue.mock.calls[0]?.[0]).toEqual({ name: 'desktop' });
    expect(shownLine('AGENT_BOARD_TOKEN')).toBe('abm_secret-token');
    const line = shownLine('AGENT_BOARD_DATA_KEY');
    expect(line).toMatch(/^abk1_/);
    const machineKeys = await deriveKeys(decodeDataKey(line ?? ''), 'jascha');
    expect(machineKeys.keyId).toBe(setup.keyId);
    expect(await openAs(machineKeys, TITLE, sealedByBrowser)).toBe('sealed in the browser');
  });

  it('refuses a name that is not a machine name before asking for the passphrase', async () => {
    renderPage();
    await userEvent.type(await screen.findByLabelText('Add a machine'), 'my laptop');
    expect(await screen.findByText(/^Use 1 to 64 characters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
  });

  it('issues no token when the passphrase is wrong', async () => {
    renderPage();
    await userEvent.type(await screen.findByLabelText('Add a machine'), 'desktop');
    await askFor('Create token', 'not the passphrase');
    expect(await screen.findByText('Wrong passphrase or recovery key.')).toBeInTheDocument();
    expect(issue).not.toHaveBeenCalled();
    expect(shownLine('AGENT_BOARD_DATA_KEY')).toBeUndefined();
  });

  it('shows just the data key for a machine that already has a token', async () => {
    renderPage();
    await askFor('Show data key', PASSPHRASE);
    await waitFor(() => expect(shownLine('AGENT_BOARD_DATA_KEY')).toMatch(/^abk1_/));
    expect(issue).not.toHaveBeenCalled();
    expect(shownLine('AGENT_BOARD_TOKEN')).toBeUndefined();
  });

  // The board reports the slots and key id it likes. What is shown, or re-wrapped, must be the key this browser uses.
  it('shows no data key when the slots the board serves open another key than the one in use (a second key)', async () => {
    const second = await createKeySetup({ owner: 'jascha', passphrase: PASSPHRASE, kdf: { m: 8192, t: 1, p: 1 } });
    expect(second.setup.keyId).not.toBe(setup.keyId);
    stored.current = second.setup;
    renderPage();
    await askFor('Show data key', PASSPHRASE);
    expect(await screen.findByText(/does not match the one the board is set up with/)).toBeInTheDocument();
    expect(shownLine('AGENT_BOARD_DATA_KEY')).toBeUndefined();
  });

  it('shows the key id this browser uses, not the one the board reports', async () => {
    const second = await createKeySetup({ owner: 'jascha', passphrase: PASSPHRASE, kdf: { m: 8192, t: 1, p: 1 } });
    stored.current = second.setup;
    renderPage();
    expect(await screen.findByText(held.keyId)).toBeInTheDocument();
    expect(screen.queryByText(second.setup.keyId)).not.toBeInTheDocument();
  });
});

describe('what the machines list says about each CLI', () => {
  it('shows the version and whether it needs an update, is refused, or is not known', async () => {
    machines.current = [
      { name: 'a', lastSeenAt: null, revokedAt: null, clientVersion: '0.7.0', clientStatus: 'current' },
      { name: 'b', lastSeenAt: null, revokedAt: null, clientVersion: '0.5.0', clientStatus: 'outdated' },
      { name: 'c', lastSeenAt: null, revokedAt: null, clientVersion: '0.4.0', clientStatus: 'incompatible' },
      { name: 'd', lastSeenAt: null, revokedAt: null, clientVersion: null, clientStatus: 'unknown' },
    ];
    renderPage();
    expect(await screen.findByText('0.7.0')).toBeInTheDocument();
    expect(screen.getByText('0.5.0 · update available')).toBeInTheDocument();
    expect(screen.getByText('0.4.0 · incompatible — run board self-update')).toBeInTheDocument();
    expect(screen.getByText('version unknown')).toBeInTheDocument();
    expect(screen.getByText(/The newest CLI is 0\.7\.0/)).toBeInTheDocument();
  });
});

describe('what the machines list says about usage', () => {
  const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();
  const status = {
    limits: { fiveHour: 80, priority: 'urgent' },
    windows: {
      fiveHour: { percent: 85, resetsAt: minutes(125), seenAt: minutes(-2) },
      sevenDay: { percent: 40, resetsAt: minutes(60 * 48), seenAt: minutes(-2) },
    },
    reached: ['fiveHour'],
    held: ['t1', 't2'],
    open: [],
  };
  const row = (overrides: Partial<MachineRow>): MachineRow => ({
    name: 'laptop',
    lastSeenAt: minutes(-1),
    revokedAt: null,
    clientVersion: '0.7.0',
    clientStatus: 'current' as const,
    ...overrides,
  });
  const sealedStatus = (value: unknown) => sealerFor(held)(machineUsageBinding('laptop'), JSON.stringify(value));

  it('shows the readings, the limits and the hold with its reason, until and held count', async () => {
    machines.current = [row({ usage: await sealedStatus(status), usageUpdatedAt: minutes(-2) })];
    renderPage();
    const readings = await screen.findByText('Usage 5-hour 85% · 7-day 40%');
    expect(readings).toHaveAttribute('title', expect.stringMatching(/^5-hour resets .*; 7-day resets /));
    expect(screen.getByText('Limits 5-hour 80% · holds below urgent')).toBeInTheDocument();
    // The reset is 125 minutes away, so late in the day it falls on the next one and the time carries its date.
    expect(
      screen.getByText(
        /Holding tasks below urgent until (\d{1,2} \w{3}, )?\d{2}:\d{2}: 5-hour usage 85% \(limit 80%\) · 2 tasks held$/,
      ),
    ).toBeInTheDocument();
  });

  it('says as of when for a machine not seen for a while', async () => {
    machines.current = [row({ usage: await sealedStatus(status), usageUpdatedAt: minutes(-60) })];
    renderPage();
    expect(await screen.findByText(/2 tasks held \(as of an hour ago\)$/)).toBeInTheDocument();
  });

  it('shows no hold line when no window is reached, but still the readings', async () => {
    const quiet = { ...status, reached: [] };
    machines.current = [row({ usage: await sealedStatus(quiet), usageUpdatedAt: minutes(-2) })];
    renderPage();
    expect(await screen.findByText('Usage 5-hour 85% · 7-day 40%')).toBeInTheDocument();
    expect(screen.queryByText(/Holding tasks/)).not.toBeInTheDocument();
  });

  it('says a status that does not open is unreadable, and shows nothing for a machine that sent none', async () => {
    machines.current = [row({ usage: 'abe1.notanenvelope' }), row({ name: 'desktop', usage: null })];
    renderPage();
    expect(await screen.findAllByText('usage status unreadable')).toHaveLength(1);
    expect(screen.queryByText(/^Usage /)).not.toBeInTheDocument();
  });
});

describe('desktop notifications', () => {
  const requestPermission = vi.fn<() => Promise<NotificationPermission>>();

  const mockNotification = (permission: NotificationPermission) => {
    requestPermission.mockResolvedValue(permission);
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission, requestPermission }));
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('turns on after the browser grants permission, and remembers it', async () => {
    mockNotification('default');
    requestPermission.mockResolvedValue('granted');
    renderPage();
    await userEvent.click(await screen.findByRole('switch', { name: 'Notify me when a task needs me' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Notify me when a task needs me' })).toBeChecked());
    expect(localStorage.getItem('agent-board.desktopNotifications')).toBe('on');
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeInTheDocument();
  });

  it('stays off when the browser refuses permission', async () => {
    mockNotification('default');
    requestPermission.mockResolvedValue('denied');
    renderPage();
    await userEvent.click(await screen.findByRole('switch', { name: 'Notify me when a task needs me' }));
    expect(await screen.findByText(/blocks notifications for this site/)).toBeInTheDocument();
    expect(localStorage.getItem('agent-board.desktopNotifications')).toBeNull();
  });

  it('is disabled and says why when notifications are blocked', async () => {
    mockNotification('denied');
    renderPage();
    expect(await screen.findByRole('switch', { name: 'Notify me when a task needs me' })).toBeDisabled();
    expect(screen.getByText(/blocks notifications for this site/)).toBeInTheDocument();
  });

  it('explains that a browser without notifications needs https or localhost', async () => {
    vi.stubGlobal('Notification', undefined);
    renderPage();
    expect(await screen.findByRole('switch', { name: 'Notify me when a task needs me' })).toBeDisabled();
    expect(screen.getByText(/need https or localhost/)).toBeInTheDocument();
  });

  it('turns off without asking the browser again', async () => {
    mockNotification('granted');
    localStorage.setItem('agent-board.desktopNotifications', 'on');
    renderPage();
    await userEvent.click(await screen.findByRole('switch', { name: 'Notify me when a task needs me' }));
    await waitFor(() => expect(localStorage.getItem('agent-board.desktopNotifications')).toBeNull());
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
