import { ActionIcon, Button, Group, Paper, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCheck, IconPencil, IconX } from '@tabler/icons-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryStatus } from '../components/QueryStatus';
import { ago } from '../lib/time';
import { errorMessage, useTRPC } from '../lib/trpc';
import { useAttempt } from './useAttempt';
import { createPasskey } from './webauthn';

const MAX_NAME = 60;

/** The passkeys the signed-in user can sign in with: add one on this device, rename, remove. */
export function Passkeys() {
  const trpc = useTRPC();
  const passkeys = useQuery(trpc.passkeys.list.queryOptions());
  const registerOptions = useMutation(trpc.passkeys.registerOptions.mutationOptions());
  const register = useMutation(trpc.passkeys.register.mutationOptions());
  const rename = useMutation(trpc.passkeys.rename.mutationOptions());
  const remove = useMutation(trpc.passkeys.remove.mutationOptions());
  const supported = browserSupportsWebAuthn();
  const { busy, error, note, run } = useAttempt();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const newName = name.trim();
  const editedName = editing?.name.trim() ?? '';

  const add = async () => {
    if (newName === '') return;
    await run(async () => {
      const { flow, options } = await registerOptions.mutateAsync();
      const response = await createPasskey(options);
      await register.mutateAsync({ flow, response, name: newName });
      setName('');
    });
  };
  const save = () => {
    if (editing === null || editedName === '') return;
    rename.mutate({ id: editing.id, name: editedName }, { onSuccess: () => setEditing(null) });
  };

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Sign-in</Title>
          <Text size="sm" c="dimmed">
            The passkeys you sign in to this board with.
          </Text>
        </div>
        <QueryStatus query={passkeys} what="passkeys" />
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Added</Table.Th>
              <Table.Th>Last used</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(passkeys.data ?? []).map((passkey) => (
              <Table.Tr key={passkey.id}>
                <Table.Td>
                  {editing?.id === passkey.id ? (
                    <Group gap="xs" wrap="nowrap">
                      <TextInput
                        aria-label="New name"
                        size="xs"
                        maxLength={MAX_NAME}
                        value={editing.name}
                        onChange={(event) => setEditing({ id: passkey.id, name: event.currentTarget.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') save();
                          if (event.key === 'Escape') setEditing(null);
                        }}
                        data-autofocus
                      />
                      <Tooltip label="Save">
                        <ActionIcon
                          variant="default"
                          aria-label="Save name"
                          disabled={editedName === ''}
                          onClick={save}
                        >
                          <IconCheck size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Cancel">
                        <ActionIcon variant="default" aria-label="Cancel rename" onClick={() => setEditing(null)}>
                          <IconX size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  ) : (
                    <Text size="sm">{passkey.name}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {ago(passkey.createdAt)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {passkey.lastUsedAt ? ago(passkey.lastUsedAt) : 'never'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconPencil size={14} />}
                      onClick={() => setEditing({ id: passkey.id, name: passkey.name })}
                    >
                      Rename
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        modals.openConfirmModal({
                          title: `Remove ${passkey.name}?`,
                          children: <Text size="sm">You can no longer sign in with this passkey.</Text>,
                          labels: { confirm: 'Remove', cancel: 'Cancel' },
                          confirmProps: { color: 'red' },
                          onConfirm: () => remove.mutate({ id: passkey.id }),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {remove.isError && (
          <Text size="sm" c="red">
            {errorMessage(remove.error)}
          </Text>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Group align="flex-end">
            <TextInput
              label="Add a passkey"
              description="A name for this device, such as laptop or phone."
              placeholder="laptop"
              maxLength={MAX_NAME}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              error={error}
              style={{ flex: 1 }}
            />
            <Button type="submit" disabled={newName === '' || !supported} loading={busy}>
              Add passkey
            </Button>
          </Group>
        </form>
        {note && (
          <Text size="sm" c="dimmed">
            {note}
          </Text>
        )}
        {!supported && (
          <Text size="sm" c="dimmed">
            This browser does not support passkeys.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
