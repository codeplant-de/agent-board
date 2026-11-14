import { prUrlIn, type UnreadableField } from '@agent-board/shared';
import {
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Spoiler,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconBrandGithub, IconCornerDownRight, IconLockOff, IconTerminal2 } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ActionPanel } from '../components/ActionPanel';
import { Markdown } from '../components/Markdown';
import { PriorityPicker } from '../components/PriorityPicker';
import { PolishItem } from '../components/PolishItem';
import { TaskBadges } from '../components/TaskBadges';
import { ThreadItem } from '../components/ThreadItem';
import { TranscriptDrawer } from '../components/TranscriptDrawer';
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { ago, stamp } from '../lib/time';
import { errorMessage, POLL_MS, useTRPC } from '../lib/trpc';

const UNREADABLE_LABEL = (field: UnreadableField): string =>
  field === 'input' ? 'prompt' : field === 'workdir' ? 'directory' : field;

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
  const pr = prUrlIn(task.input);

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
            <PriorityPicker
              value={task.priority}
              onChange={(priority) => setPriority.mutate({ id: task.id, priority })}
            />
            <TaskBadges task={task} withPriority={false} />
            <Text size="xs" c="dimmed" title={stamp(task.createdAt)}>
              created by {task.createdBy} {ago(task.createdAt)}
            </Text>
          </Group>
          {task.workdir && (
            <Text
              size="xs"
              c="dimmed"
              ff="monospace"
              title="Where the task's session last worked; a resume starts here"
            >
              {task.machine ? `${task.machine}:` : ''}
              {task.workdir}
            </Text>
          )}
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconTerminal2 size={14} />}
              onClick={() => setTranscriptOpen(true)}
            >
              Transcript
            </Button>
          </Group>
          {pr && (
            <Group>
              <Button
                component="a"
                href={pr}
                target="_blank"
                rel="noopener noreferrer"
                variant="default"
                size="xs"
                leftSection={<IconBrandGithub size={14} />}
              >
                {pr.replace('https://github.com/', '')}
              </Button>
            </Group>
          )}
        </Stack>

        {task.invalid.length > 0 && (
          <Alert
            color="orange"
            variant="light"
            icon={<IconLockOff size={18} />}
            title="The board sent unexpected values"
          >
            <Text size="sm">
              The board sent {task.invalid.join(', ')} for this task in a form it does not use, so neutral values are
              shown instead. Treat this task with care.
            </Text>
          </Alert>
        )}

        {task.unreadable.length > 0 && (
          <Alert
            color="orange"
            variant="light"
            icon={<IconLockOff size={18} />}
            title="Part of this task cannot be read"
          >
            <Text size="sm">
              This browser could not decrypt the task&apos;s {task.unreadable.map(UNREADABLE_LABEL).join(', ')}. It was
              not written with your key, or it is damaged, so it is not shown. Workers will not run the task.
            </Text>
          </Alert>
        )}

        {task.input && (
          <Paper withBorder p="sm">
            <Text size="xs" c="dimmed" fw={600} mb={4} tt="uppercase">
              Prompt
            </Text>
            <Spoiler maxHeight={180} showLabel="Show all" hideLabel="Show less">
              <Markdown>{task.input}</Markdown>
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
          {thread.map((note, index) =>
            note.kind === 'polish' && !note.unreadable ? (
              <PolishItem key={index} note={note} task={task} parent={parent} />
            ) : (
              <ThreadItem key={index} note={note} thread={thread} />
            ),
          )}
        </Stack>

        <TranscriptDrawer
          taskId={task.id}
          opened={transcriptOpen}
          onClose={() => setTranscriptOpen(false)}
          live={task.status === 'running'}
        />

        <div ref={bottom}>
          <ActionPanel task={task} thread={thread} followUps={followUps} />
        </div>
      </Stack>
    </Container>
  );
}
