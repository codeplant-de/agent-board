import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { KeyGate } from './KeyGate';
import { createKeySetup } from './keySlots';
import { createMemoryKeyStore } from './keyStore';
import { useKeys } from './KeyContext';
import type { Keys } from '@agent-board/shared';

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    me: { queryKey: () => ['me'] },
    keys: {
      get: { queryOptions: () => ({ queryKey: ['keys'], queryFn: async () => null }) },
      setup: { mutationOptions: () => ({ mutationFn: async () => null }) },
      replaceSlots: { mutationOptions: () => ({ mutationFn: async () => null }) },
    },
  }),
  errorMessage: String,
}));

function Probe() {
  return <p>unlocked as {useKeys()?.owner}</p>;
}

let keys: Keys;

beforeAll(async () => {
  ({ keys } = await createKeySetup({
    owner: 'jascha',
    passphrase: 'correct horse battery staple',
    kdf: { m: 8192, t: 1, p: 1 },
  }));
});

function renderGate(me: { username: string; keyId: string | null }, store = createMemoryKeyStore(keys)) {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <KeyGate me={me} store={store}>
          <Probe />
        </KeyGate>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return store;
}

describe('KeyGate', () => {
  it('sets up encryption when the board has no key', async () => {
    renderGate({ username: 'jascha', keyId: null });
    expect(await screen.findByText('Set up encryption')).toBeInTheDocument();
  });

  it('opens the app with a stored key that is this user’s and this key id', async () => {
    renderGate({ username: 'jascha', keyId: keys.keyId });
    expect(await screen.findByText('unlocked as jascha')).toBeInTheDocument();
  });

  it('asks for the passphrase when there is no stored key', async () => {
    renderGate({ username: 'jascha', keyId: keys.keyId }, createMemoryKeyStore());
    expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
  });

  it('ignores and deletes a stored key of another user', async () => {
    const store = renderGate({ username: 'someone-else', keyId: keys.keyId });
    expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
    expect(await store.load()).toBeUndefined();
  });

  it('ignores and deletes a stored key with another key id', async () => {
    const store = renderGate({ username: 'jascha', keyId: '0123456789abcdef' });
    expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
    expect(await store.load()).toBeUndefined();
  });
});
