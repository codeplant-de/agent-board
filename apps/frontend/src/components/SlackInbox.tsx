import { defaultTitle } from '@agent-board/shared';
import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconBrandSlack } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ago } from '../lib/time';
import { POLL_MS, useTRPC } from '../lib/trpc';
import { NewTaskModal } from './NewTaskModal';

interface Item {
  id: string;
  text: string;
  createdAt: Date | string;
}

/**
 * What users sent with `/board <text>`. It is plain text because the server cannot seal it, so it never becomes a task on
 * its own: "Create task" opens the new-task modal with it, and the browser seals what you create from it.
 */
export function SlackInbox() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inbox = useQuery({ ...trpc.slack.inbox.list.queryOptions(), refetchInterval: POLL_MS });
  const remove = useMutation({
    ...trpc.slack.inbox.remove.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries(trpc.slack.inbox.list.queryFilter()),
  });
  const [drafting, setDrafting] = useState<Item | null>(null);
  const items = inbox.data ?? [];
  if (items.length === 0) return null;

  return (
    <Paper withBorder p="sm" radius="md" aria-label="From Slack">
      <Stack gap="xs">
        <Group gap="xs">
          <IconBrandSlack size={18} />
          <Text fw={600} size="sm">
            From Slack
          </Text>
          <Badge color="yellow" variant="light" size="sm">
            unencrypted text
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          Sent from Slack in clear text: the board server could read or change it. Check it before you create a task. It
          is deleted when you create a task from it or dismiss it, and after 30 days.
        </Text>
        {items.map((item) => (
          <Group key={item.id} justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" lineClamp={3} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {item.text}
              </Text>
              <Text size="xs" c="dimmed">
                {ago(item.createdAt)}
              </Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Button size="compact-sm" onClick={() => setDrafting(item)}>
                Create task
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                loading={remove.isPending && remove.variables?.id === item.id}
                onClick={() => remove.mutate({ id: item.id })}
              >
                Dismiss
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
      {drafting && (
        <NewTaskModal
          key={drafting.id}
          opened
          onClose={() => setDrafting(null)}
          initial={{ title: defaultTitle(drafting.text), input: drafting.text }}
          onCreated={() => remove.mutate({ id: drafting.id })}
        />
      )}
    </Paper>
  );
}
