import { decodeDataKey, deriveKeys, type KeySetup, type Keys } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyProvider } from '../crypto/KeyProvider';
import { createKeySetup } from '../crypto/keySlots';
import { SettingsPage } from './SettingsPage';
import { openAs, sealerFor } from '../lib/contexts';

const TITLE = { field: 'title', context: 'task:abc' } as const;

const issue = vi.hoisted(() => vi.fn(async (_: unknown) => ({ token: 'abm_secret-token' })));
const machines = vi.hoisted(() => ({
  current: [] as { name: string; lastSeenAt: string | null; revokedAt: string | null }[],
}));
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
      list: { queryOptions: () => ({ queryKey: ['machines'], queryFn: async () => machines.current }) },
      issue: { mutationOptions: () => ({ mutationFn: issue }) },
      revoke: { mutationOptions: () => ({ mutationFn: async () => null }) },
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
  stored.current = setup;
  machines.current = [{ name: 'laptop', lastSeenAt: null, revokedAt: null }];
});

async function askFor(button: string, passphrase: string) {
  await userEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Passphrase', { selector: 'input' }), passphrase);
  await userEvent.click(within(dialog).getByRole('button', { name: button }));
}

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
