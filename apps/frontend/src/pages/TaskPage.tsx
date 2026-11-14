import { Anchor, Badge, Breadcrumbs, Button, Center, Container, Group, Loader, Paper, Spoiler, Stack, Text, Title } from '@mantine/core';
import { IconBrandGithub, IconCornerDownRight, IconTerminal2 } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ActionPanel } from '../components/ActionPanel';
import { Markdown } from '../components/Markdown';
import { PriorityPicker } from '../components/PriorityPicker';
import { TaskBadges } from '../components/TaskBadges';
import { ThreadItem } from '../components/ThreadItem';
import { TranscriptDrawer } from '../components/TranscriptDrawer';
import { promptText, prUrl, STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { ago, stamp } from '../lib/time';
import { errorMessage, POLL_MS, useTRPC } from '../lib/trpc';

export function TaskPage() {
  const { id = '' } = useParams();
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.tasks.get.queryOptions({ id }), refetchInterval: POLL_MS });
  const setPriority = useMutation(trpc.tasks.setPriority.mutationOptions());
  const bottom = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useSearchParams();
  const transcriptOpen = search.get('transcript') !== null;
  const setTranscriptOpen = (open: boolean) => setSearch(open ? { transcript: '1' } : {}, { replace: true });
  const noteCount = query.data?.thread.length ?? 0;

  // Land on the newest note and the action panel; follow new notes as they arrive.
  useEffect(() => {
    if (noteCount > 0) bottom.current?.scrollIntoView({ block: 'end' });
  }, [noteCount]);

  if (query.isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!query.data) {
    return (
      <Center py="xl">
        <Text c="red">{errorMessage(query.error)}</Text>
      </Center>
    );
  }

  const { task, thread, followUps, parent } = query.data;
  const pr = prUrl(task.input);
  const input = promptText(task.input);

  return (
    <Container size="md" px={0}>
      <Stack gap="md" pb="xl">
        <Breadcrumbs>
          <Anchor component={Link} to="/" size="sm">
            Board
          </Anchor>
          {parent && (
            <Anchor component={Link} to={`/t/${parent.id}`} size="sm">
              {parent.title}
            </Anchor>
          )}
          <Text size="sm" c="dimmed">
            {task.id}
          </Text>
        </Breadcrumbs>

        <Stack gap="xs">
          <Title order={3}>{task.title}</Title>
          <Group gap="xs">
            <Badge color={STATUS_COLOR[task.status]}>{task.closed ? 'Closed' : STATUS_LABEL[task.status]}</Badge>
            <PriorityPicker value={task.priority} onChange={(priority) => setPriority.mutate({ id: task.id, priority })} />
            <TaskBadges task={task} withPriority={false} />
            <Text size="xs" c="dimmed" title={stamp(task.createdAt)}>
              created by {task.createdBy} {ago(task.createdAt)}
            </Text>
          </Group>
          {task.workdir && (
            <Text size="xs" c="dimmed" ff="monospace" title="Where the task's session last worked; a resume starts here">
              {task.machine ? `${task.machine}:` : ''}
              {task.workdir}
            </Text>
          )}
          <Group gap="xs">
            <Button variant="default" size="xs" leftSection={<IconTerminal2 size={14} />} onClick={() => setTranscriptOpen(true)}>
              Transcript
            </Button>
          </Group>
          {pr && (
            <Group>
              <Button component="a" href={pr} target="_blank" rel="noopener noreferrer" variant="default" size="xs" leftSection={<IconBrandGithub size={14} />}>
                {pr.replace('https://github.com/', '')}
              </Button>
            </Group>
          )}
        </Stack>

        {input && (
          <Paper withBorder p="sm">
            <Text size="xs" c="dimmed" fw={600} mb={4} tt="uppercase">
              Prompt
            </Text>
            <Spoiler maxHeight={180} showLabel="Show all" hideLabel="Show less">
              <Text size="sm" ff="monospace" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {input}
              </Text>
            </Spoiler>
          </Paper>
        )}

        {followUps.length > 0 && (
          <Paper withBorder p="sm">
            <Text size="xs" c="dimmed" fw={600} mb={4} tt="uppercase">
              Follow-ups
            </Text>
            <Stack gap={4}>
              {followUps.map((f) => (
                <Group key={f.id} gap="xs">
                  <IconCornerDownRight size={14} />
                  <Anchor component={Link} to={`/t/${f.id}`} size="sm">
                    {f.title}
                  </Anchor>
                  <Badge size="xs" color={STATUS_COLOR[f.status]} variant="light">
                    {STATUS_LABEL[f.status]}
                  </Badge>
                  <TaskBadges task={f} withLabels={false} />
                </Group>
              ))}
            </Stack>
          </Paper>
        )}

        <Stack gap="sm">
          {thread.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No activity yet.
            </Text>
          )}
          {thread.map((note) => (
            <ThreadItem key={note.id} note={note} thread={thread} />
          ))}
        </Stack>

        <TranscriptDrawer taskId={task.id} opened={transcriptOpen} onClose={() => setTranscriptOpen(false)} live={task.status === 'running'} />

        <div ref={bottom}>
          <ActionPanel task={task} thread={thread} />
        </div>
      </Stack>
    </Container>
  );
}
