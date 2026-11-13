import { Anchor, Badge, Breadcrumbs, Button, Center, Container, Group, Loader, Paper, Spoiler, Stack, Text, Title } from '@mantine/core';
import { IconBrandGithub, IconCornerDownRight } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActionPanel } from '../components/ActionPanel';
import { Markdown } from '../components/Markdown';
import { PriorityPicker } from '../components/PriorityPicker';
import { TaskBadges } from '../components/TaskBadges';
import { ThreadItem } from '../components/ThreadItem';
import { prUrl, STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { ago, stamp } from '../lib/time';
import { errorMessage, POLL_MS, useTRPC } from '../lib/trpc';

export function TaskPage() {
  const { id = '' } = useParams();
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.tasks.get.queryOptions({ id }), refetchInterval: POLL_MS });
  const setPriority = useMutation(trpc.tasks.setPriority.mutationOptions());
  const bottom = useRef<HTMLDivElement>(null);
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
  const input = pr ? task.input.split('\n').slice(1).filter((line) => !/^head:\s/.test(line.trim())).join('\n').trim() : task.input.trim();

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
              Task
            </Text>
            <Spoiler maxHeight={180} showLabel="Show all" hideLabel="Show less">
              <Markdown>{input}</Markdown>
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

        <div ref={bottom}>
          <ActionPanel task={task} thread={thread} />
        </div>
      </Stack>
    </Container>
  );
}
