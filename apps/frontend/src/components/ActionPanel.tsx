import { Alert, Button, Group, Kbd, Loader, Menu, Paper, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconArchive,
  IconArchiveOff,
  IconCheck,
  IconChevronDown,
  IconMessage,
  IconPlayerPlay,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ago } from '../lib/time';
import { useTRPC, type BoardTask, type ThreadNote } from '../lib/trpc';
import { MarkdownEditor } from './MarkdownEditor';
import { QuestionPanel } from './QuestionPanel';

function useActions(id: string) {
  const trpc = useTRPC();
  return {
    answer: useMutation(trpc.tasks.answer.mutationOptions()),
    reply: useMutation(trpc.tasks.reply.mutationOptions()),
    done: useMutation(trpc.tasks.done.mutationOptions()),
    rerun: useMutation(trpc.tasks.rerun.mutationOptions()),
    close: useMutation(trpc.tasks.setClosed.mutationOptions()),
    move: useMutation(trpc.tasks.move.mutationOptions()),
    id,
  };
}

/** A note for the thread that does not wake the agent: always possible, even while it runs. */
function CommentOnly({ actions, hint }: { actions: ReturnType<typeof useActions>; hint: string }) {
  const [message, setMessage] = useState('');
  const send = () =>
    message.trim() && actions.reply.mutate({ id: actions.id, message, resume: false }, { onSuccess: () => setMessage('') });
  return (
    <Stack gap="xs">
      <MarkdownEditor value={message} onChange={setMessage} minRows={2} onSubmit={send} placeholder={hint} />
      <Group justify="flex-end">
        <Button variant="default" leftSection={<IconMessage size={16} />} onClick={send} disabled={!message.trim()} loading={actions.reply.isPending}>
          Comment
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * What you can do with the task now, as explicit buttons: answer the agent's question, send it a follow-up,
 * finish it, start it over, or start a proposal.
 */
export function ActionPanel({ task, thread }: { task: BoardTask; thread: ThreadNote[] }) {
  const actions = useActions(task.id);
  const [message, setMessage] = useState('');
  const openQuestion = task.openQuestion ? thread.findLast((n) => n.kind === 'question') : undefined;
  const startedAt = thread.findLast((n) => n.author === 'system' && n.text.startsWith('agent-board: started'))?.createdAt;

  if (task.closed) {
    return (
      <Paper withBorder p="md">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            This task is closed. Workers ignore it.
          </Text>
          <Button variant="default" leftSection={<IconArchiveOff size={16} />} onClick={() => actions.close.mutate({ id: task.id, closed: false })}>
            Reopen
          </Button>
        </Group>
      </Paper>
    );
  }

  if (task.status === 'running') {
    return (
      <Paper withBorder p="md">
        <Stack>
          <Group gap="sm">
            <Loader size="xs" />
            <Text size="sm">
              Running on <b>{task.machine ?? 'a worker'}</b>
              {startedAt ? ` since ${ago(startedAt)}` : ''}. It reports back here when it is done or has a question.
            </Text>
          </Group>
          <CommentOnly actions={actions} hint="Leave a note for later (does not reach the running agent)" />
        </Stack>
      </Paper>
    );
  }

  if (openQuestion?.questions) {
    return (
      <QuestionPanel
        key={openQuestion.id}
        questions={openQuestion.questions}
        submitting={actions.answer.isPending}
        onSubmit={(answers, note) => actions.answer.mutate({ id: task.id, questionNoteId: openQuestion.id, answers, message: note })}
      />
    );
  }

  if (task.status === 'todo') {
    return (
      <Paper withBorder p="md">
        <Stack>
          <Text size="sm">
            Queued.{' '}
            {task.next === 'resume'
              ? `The next run resumes the agent's session${task.machine ? ` on ${task.machine}` : ''} with your reply.`
              : 'The next free worker starts it.'}
          </Text>
          <CommentOnly actions={actions} hint="Add to the thread before it starts" />
        </Stack>
      </Paper>
    );
  }

  const send = () => {
    if (!message.trim()) return;
    actions.reply.mutate({ id: task.id, message, resume: true }, { onSuccess: () => setMessage('') });
  };
  const confirmRerun = () =>
    modals.openConfirmModal({
      title: 'Re-run from scratch?',
      children: <Text size="sm">The next run starts a new session and does not see the earlier one, only this thread.</Text>,
      labels: { confirm: 'Re-run', cancel: 'Cancel' },
      onConfirm: () => actions.rerun.mutate({ id: task.id }),
    });

  return (
    <Paper withBorder p="md">
      <Stack>
        {task.proposed && (
          <Alert color="grape" variant="light" icon={<IconSparkles size={18} />} title="Proposed by an agent">
            <Group justify="space-between">
              <Text size="sm">Nothing runs until you start it.</Text>
              <Group gap="xs">
                <Button size="xs" color="grape" leftSection={<IconPlayerPlay size={14} />} onClick={() => actions.move.mutate({ id: task.id, status: 'todo' })}>
                  Start
                </Button>
                <Button size="xs" variant="default" onClick={() => actions.close.mutate({ id: task.id, closed: true })}>
                  Discard
                </Button>
              </Group>
            </Group>
          </Alert>
        )}
        <MarkdownEditor
          value={message}
          onChange={setMessage}
          minRows={3}
          onSubmit={send}
          placeholder={task.sessionId ? 'Steer the agent: a follow-up, a correction, a new instruction…' : 'Instructions for the run…'}
        />
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Button variant="default" leftSection={<IconCheck size={16} />} onClick={() => actions.done.mutate({ id: task.id })} disabled={task.status === 'done'} loading={actions.done.isPending}>
              Mark done
            </Button>
            <Menu position="top-start">
              <Menu.Target>
                <Button variant="subtle" color="gray" rightSection={<IconChevronDown size={14} />}>
                  More
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconRefresh size={14} />} onClick={confirmRerun}>
                  Re-run fresh
                </Menu.Item>
                <Menu.Item leftSection={<IconMessage size={14} />} disabled={!message.trim()} onClick={() => actions.reply.mutate({ id: task.id, message, resume: false }, { onSuccess: () => setMessage('') })}>
                  Comment without continuing
                </Menu.Item>
                <Menu.Item leftSection={<IconArchive size={14} />} color="red" onClick={() => actions.close.mutate({ id: task.id, closed: true })}>
                  Close
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed" visibleFrom="sm">
              <Kbd size="xs">⌘</Kbd>+<Kbd size="xs">Enter</Kbd>
            </Text>
            <Button leftSection={<IconPlayerPlay size={16} />} onClick={send} disabled={!message.trim()} loading={actions.reply.isPending}>
              {task.sessionId ? 'Send & continue' : 'Send & run'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
