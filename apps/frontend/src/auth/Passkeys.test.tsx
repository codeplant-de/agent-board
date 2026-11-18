import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Passkeys } from './Passkeys';

const supported = vi.hoisted(() => ({ current: true }));
const created = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => ({
  registerOptions: vi.fn(),
  register: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}));
const listed = vi.hoisted(() => ({
  current: [] as { id: string; name: string; createdAt: string; lastUsedAt: string | null }[],
}));

vi.mock('../lib/trpc', () => ({
  errorMessage: String,
  useTRPC: () => ({
    passkeys: {
      list: { queryOptions: () => ({ queryKey: ['passkeys'], queryFn: async () => listed.current }) },
      registerOptions: { mutationOptions: () => ({ mutationFn: calls.registerOptions }) },
      register: { mutationOptions: () => ({ mutationFn: calls.register }) },
      rename: { mutationOptions: () => ({ mutationFn: calls.rename }) },
      remove: { mutationOptions: () => ({ mutationFn: calls.remove }) },
    },
  }),
}));
vi.mock('@simplewebauthn/browser', () => ({ browserSupportsWebAuthn: () => supported.current }));
vi.mock('./webauthn', () => ({ createPasskey: created }));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function renderSection() {
  render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Passkeys />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  supported.current = true;
  for (const mock of [created, ...Object.values(calls)]) mock.mockReset();
  for (const mock of [calls.rename, calls.remove]) mock.mockResolvedValue(undefined);
  listed.current = [
    { id: 'p1', name: 'laptop', createdAt: minutesAgo(180), lastUsedAt: minutesAgo(5) },
    { id: 'p2', name: 'phone', createdAt: minutesAgo(60 * 24 * 3), lastUsedAt: null },
  ];
});

describe('the passkeys section', () => {
  it('lists each passkey with its name, when it was added and when it was last used', async () => {
    renderSection();
    const laptop = (await screen.findByText('laptop')).closest('tr');
    expect(laptop).not.toBeNull();
    expect(within(laptop as HTMLElement).getByText('3 hours ago')).toBeInTheDocument();
    expect(within(laptop as HTMLElement).getByText('5 minutes ago')).toBeInTheDocument();
    const phone = screen.getByText('phone').closest('tr') as HTMLElement;
    expect(within(phone).getByText('3 days ago')).toBeInTheDocument();
    expect(within(phone).getByText('never')).toBeInTheDocument();
  });

  it('shows a name from the board as text', async () => {
    listed.current = [{ id: 'p1', name: '<b>x</b>', createdAt: minutesAgo(1), lastUsedAt: null }];
    renderSection();
    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('adds a passkey: the board’s options go to the authenticator and its answer comes back with the name', async () => {
    calls.registerOptions.mockResolvedValue({ flow: 'f1', options: { challenge: 'c' } });
    created.mockResolvedValue({ id: 'new', type: 'public-key' });
    calls.register.mockResolvedValue(undefined);
    renderSection();
    expect(await screen.findByRole('button', { name: 'Add passkey' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Add a passkey'), ' work phone ');
    await userEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    await waitFor(() => expect(calls.register).toHaveBeenCalled());
    expect(created).toHaveBeenCalledWith({ challenge: 'c' });
    expect(calls.register.mock.calls[0]?.[0]).toEqual({
      flow: 'f1',
      response: { id: 'new', type: 'public-key' },
      name: 'work phone',
    });
    await waitFor(() => expect(screen.getByLabelText('Add a passkey')).toHaveValue(''));
  });

  it('says a cancelled prompt was cancelled and registers nothing', async () => {
    calls.registerOptions.mockResolvedValue({ flow: 'f1', options: {} });
    created.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    renderSection();
    await userEvent.type(await screen.findByLabelText('Add a passkey'), 'phone');
    await userEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    expect(await screen.findByText('The passkey prompt was cancelled.')).toBeInTheDocument();
    expect(calls.register).not.toHaveBeenCalled();
  });

  it('shows a refusal by the board next to the name field', async () => {
    calls.registerOptions.mockResolvedValue({ flow: 'f1', options: {} });
    created.mockResolvedValue({ id: 'dup' });
    calls.register.mockRejectedValue(new Error('That passkey is already registered.'));
    renderSection();
    await userEvent.type(await screen.findByLabelText('Add a passkey'), 'phone');
    await userEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    expect(await screen.findByText('That passkey is already registered.')).toBeInTheDocument();
  });

  it('cannot add one in a browser without WebAuthn, and says so', async () => {
    supported.current = false;
    renderSection();
    await userEvent.type(await screen.findByLabelText('Add a passkey'), 'phone');
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeDisabled();
    expect(screen.getByText('This browser does not support passkeys.')).toBeInTheDocument();
  });

  it('renames a passkey', async () => {
    renderSection();
    const row = (await screen.findByText('laptop')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Rename' }));
    const field = within(row).getByLabelText('New name');
    expect(field).toHaveValue('laptop');
    await userEvent.clear(field);
    await userEvent.type(field, 'desk{Enter}');
    await waitFor(() => expect(calls.rename).toHaveBeenCalled());
    expect(calls.rename.mock.calls[0]?.[0]).toEqual({ id: 'p1', name: 'desk' });
    await waitFor(() => expect(within(row).queryByLabelText('New name')).not.toBeInTheDocument());
  });

  it('leaves a name alone when the rename is cancelled or empty', async () => {
    renderSection();
    const row = (await screen.findByText('laptop')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Rename' }));
    await userEvent.clear(within(row).getByLabelText('New name'));
    expect(within(row).getByRole('button', { name: 'Save name' })).toBeDisabled();
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel rename' }));
    expect(within(row).getByText('laptop')).toBeInTheDocument();
    expect(calls.rename).not.toHaveBeenCalled();
  });

  it('removes a passkey only after a confirmation', async () => {
    renderSection();
    const row = (await screen.findByText('phone')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.remove).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.remove).toHaveBeenCalled());
    expect(calls.remove.mock.calls[0]?.[0]).toEqual({ id: 'p2' });
  });

  it('shows why a passkey could not be removed', async () => {
    calls.remove.mockRejectedValue(new Error('This is your only way to sign in'));
    renderSection();
    const row = (await screen.findByText('phone')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/This is your only way to sign in/)).toBeInTheDocument();
  });

  it('keeps a passkey when the confirmation is cancelled', async () => {
    renderSection();
    const row = (await screen.findByText('phone')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls.remove).not.toHaveBeenCalled();
  });
});
