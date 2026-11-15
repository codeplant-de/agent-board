import { Alert, Button, Center, Code, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage, useTRPC } from '../lib/trpc';

/** Where the one-time link of `/board link` lands: asks whether to bind that Slack user to the signed-in board user. */
export function SlackLinkPage() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';
  const who = useQuery({ ...trpc.slack.peekLink.queryOptions({ code }), enabled: code !== '', retry: false });
  const confirm = useMutation({
    ...trpc.slack.confirmLink.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries(trpc.slack.status.queryFilter());
      notifications.show({ color: 'teal', message: 'Slack account linked.' });
      navigate('/settings');
    },
  });

  if (code === '') return <Alert color="red">This page needs the link that /board link sends in Slack.</Alert>;
  if (who.isLoading)
    return (
      <Center>
        <Loader />
      </Center>
    );
  if (who.error || !who.data) return <Alert color="red">{errorMessage(who.error)}</Alert>;

  const { slackUserId, displayName } = who.data;
  return (
    <Paper withBorder p="md" maw={560} mx="auto">
      <Stack>
        <Title order={4}>Link Slack account</Title>
        <Text>Link Slack user {displayName ?? slackUserId} to your board account?</Text>
        <Text size="sm">
          Slack user id: <Code>{slackUserId}</Code>
        </Text>
        <Alert color="yellow">
          Names in Slack can be chosen freely, so check the id. Confirm only a link you asked for yourself with{' '}
          <Code>/board link</Code> in the last 15 minutes: whoever you link can send text to your board's inbox.
        </Alert>
        <Text size="sm" c="dimmed">
          What you send with <code>/board</code> reaches your board as plain text, until you turn it into a task.
        </Text>
        {confirm.error && <Alert color="red">{errorMessage(confirm.error)}</Alert>}
        <Group>
          <Button loading={confirm.isPending} onClick={() => confirm.mutate({ code })}>
            Link
          </Button>
          <Button variant="default" onClick={() => navigate('/')}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
