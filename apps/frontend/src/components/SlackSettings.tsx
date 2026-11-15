import { Button, Code, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ago } from '../lib/time';
import { errorMessage, useTRPC } from '../lib/trpc';

/** The Slack account linked to this board user; nothing at all while the board runs without Slack. */
export function SlackSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(trpc.slack.status.queryOptions());
  const unlink = useMutation({
    ...trpc.slack.unlink.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries(trpc.slack.status.queryFilter()),
  });
  if (!status.data?.enabled) return null;
  const { link } = status.data;

  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Title order={5}>Slack</Title>
        {link ? (
          <Group justify="space-between">
            <Text size="sm">
              Linked to <strong>{link.displayName ?? link.slackUserId}</strong>
              <Text span c="dimmed">
                {' '}
                since {ago(link.createdAt)}
              </Text>
              . What you send with <code>/board</code> arrives in your board's inbox as plain text.
            </Text>
            <Button size="xs" variant="default" loading={unlink.isPending} onClick={() => unlink.mutate()}>
              Unlink
            </Button>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            Not linked. Send <Code>/board link</Code> in Slack and open the link it answers with.
          </Text>
        )}
        {unlink.error && (
          <Text size="sm" c="red">
            {errorMessage(unlink.error)}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
