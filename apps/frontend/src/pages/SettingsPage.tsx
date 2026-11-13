import { ActionIcon, Alert, Badge, Button, Code, CopyButton, Group, Paper, Stack, Table, Text, TextInput, Textarea, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ago } from '../lib/time';
import { useTRPC } from '../lib/trpc';

function Machines() {
  const trpc = useTRPC();
  const machines = useQuery(trpc.machines.list.queryOptions());
  const issue = useMutation(trpc.machines.issue.mutationOptions());
  const revoke = useMutation(trpc.machines.revoke.mutationOptions());
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  const create = (target: string) =>
    issue.mutate({ name: target }, { onSuccess: ({ token }) => { setIssued({ name: target, token }); setName(''); } });

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Worker machines</Title>
          <Text size="sm" c="dimmed">
            Each machine that runs <Code>dispatch</Code> and <Code>intake</Code> gets a token. Its name must match <Code>machine</Code> in its config.json
            (default: the host name).
          </Text>
        </div>
        {issued && (
          <Alert color="teal" icon={<IconKey size={18} />} title={`Token for ${issued.name}, shown once`} withCloseButton onClose={() => setIssued(null)}>
            <Stack gap="xs">
              <Text size="sm">
                Put it in <Code>~/.config/agent-board/env</Code> (mode 600) on that machine:
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Code block style={{ flex: 1, overflowX: 'auto' }}>
                  AGENT_BOARD_TOKEN={issued.token}
                </Code>
                <CopyButton value={`AGENT_BOARD_TOKEN=${issued.token}`}>
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
                    <Text size="sm">{m.name}</Text>
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
                    <Button size="xs" variant="default" onClick={() => create(m.name)}>
                      New token
                    </Button>
                    {!m.revokedAt && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          modals.openConfirmModal({
                            title: `Revoke ${m.name}?`,
                            children: <Text size="sm">Its dispatcher and intake stop working until it gets a new token.</Text>,
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
          <TextInput label="Add a machine" placeholder="laptop" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button onClick={() => create(name.trim())} disabled={!name.trim()} loading={issue.isPending}>
            Create token
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function LabelRow({ name, description }: { name: string; description: string }) {
  const trpc = useTRPC();
  const update = useMutation(trpc.labels.update.mutationOptions());
  const [value, setValue] = useState(description);
  return (
    <Group align="flex-start" wrap="nowrap">
      <Badge variant="default" tt="none" mt={6} style={{ flexShrink: 0 }}>
        {name}
      </Badge>
      <Textarea value={value} onChange={(e) => setValue(e.currentTarget.value)} autosize minRows={1} style={{ flex: 1 }} placeholder="What a task of this type is for" />
      <Button variant="default" disabled={value === description} loading={update.isPending} onClick={() => update.mutate({ name, description: value })}>
        Save
      </Button>
    </Group>
  );
}

function Labels() {
  const trpc = useTRPC();
  const labels = useQuery(trpc.labels.list.queryOptions());
  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Task types</Title>
          <Text size="sm" c="dimmed">
            Labels come from <Code>board setup</Code> on a machine, one per entry in its config. The description shows in the New task form.
          </Text>
        </div>
        {(labels.data ?? []).map((l) => (
          <LabelRow key={l.name} name={l.name} description={l.description} />
        ))}
      </Stack>
    </Paper>
  );
}

export function SettingsPage() {
  return (
    <Stack maw={900} mx="auto">
      <Title order={3}>Settings</Title>
      <Machines />
      <Labels />
    </Stack>
  );
}
