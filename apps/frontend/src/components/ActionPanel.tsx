import { Alert, Anchor, Button, Group, Kbd, Loader, Menu, Paper, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconArchive,
  IconArchiveOff,
  IconArrowBackUp,
  IconCheck,
  IconChevronDown,
  IconMessage,
  IconPlayerPlay,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { canTakeBack } from '../lib/liveness';
import { startsIn } from '../lib/startsIn';
import { ago, stamp } from '../lib/time';
import { useNow } from '../lib/useNow';
import { useTRPC, type BoardTask, type ThreadNote } from '../lib/trpc';
import { LivenessText } from './LivenessText';
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
    takeBack: useMutation(trpc.tasks.takeBack.mutationOptions()),
    setNotBefore: useMutation(trpc.tasks.setNotBefore.mutationOptions()),
    id,
  };
}

/** A note for the thread that does not wake the agent: always possible, even while it runs. */
function CommentOnly({ actions, hint }: { actions: ReturnType<typeof useActions>; hint: string }) {
  const [message, setMessage] = useState('');
  const send = () =>
    message.trim() &&
    actions.reply.mutate({ id: actions.id, message, resume: false }, { onSuccess: () => setMessage('') });
  return (
    <Stack gap="xs">
      <MarkdownEditor value={message} onChange={setMessage} minRows={2} onSubmit={send} placeholder={hint} />
      <Group justify="flex-end">
        <Button
          variant="default"
          leftSection={<IconMessage size={16} />}
          onClick={send}
          disabled={!message.trim()}
          loading={actions.reply.isPending}
        >
          Comment
        </Button>
      </Group>
    </Stack>
  );
}

/** For a running task whose agent has gone quiet: its worker is probably gone, and only that machine could end the run. */
function TakeBack({ task, actions }: { task: BoardTask; actions: ReturnType<typeof useActions> }) {
  const now = useNow(10_000);
  if (!canTakeBack(task.lastActiveAt, now)) return null;
  const confirm = () =>
    modals.openConfirmModal({
      title: 'Take the task back?',
      children: (
        <Text size="sm">
          The agent has been quiet for a while, so {task.machine ?? 'its worker'} may be off. The task moves to Needs
          me. If the worker is still alive, its result is dropped.
        </Text>
      ),
      labels: { confirm: 'Take back', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => actions.takeBack.mutate({ id: task.id }),
    });
  return (
    <Group justify="flex-end">
      <Button
        variant="default"
        color="red"
        leftSection={<IconArrowBackUp size={16} />}
        onClick={confirm}
        loading={actions.takeBack.isPending}
      >
        Take back
      </Button>
    </Group>
  );
}

/**
 * What you can do with the task now, as explicit buttons: answer the agent's question, send it a follow-up,
 * finish it, start it over, or start a proposal.
 */
export function ActionPanel({ task, thread }: { task: BoardTask; thread: ThreadNote[] }) {
  const actions = useActions(task.id);
  const now = useNow(30_000);
  const waiting = startsIn(task.notBefore, now) !== undefined;
  const [message, setMessage] = useState('');
  const openQuestion = task.openQuestion ? thread.findLast((n) => n.kind === 'question') : undefined;
  // An agent's proposal: only starting it, which seals its prompt again as yours, lets a worker run it.
  const isProposal = task.createdBy === 'agent';

  if (task.closed) {
    return (
      <Paper withBorder p="md">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            This task is closed. Workers ignore it.
          </Text>
          <Button
            variant="default"
            leftSection={<IconArchiveOff size={16} />}
            onClick={() => actions.close.mutate({ id: task.id, closed: false })}
          >
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
              {task.lane ? ` in the ${task.lane} lane${task.borrowed ? ' (borrowed)' : ''}` : ''}
              {task.runStartedAt ? ` since ${ago(task.runStartedAt)}` : ''}
              {' · '}
              <LivenessText span size="sm" lastActiveAt={task.lastActiveAt} />. It reports back here when it is done or
              has a question.
            </Text>
          </Group>
          <TakeBack task={task} actions={actions} />
          <CommentOnly actions={actions} hint="Leave a note for later (does not reach the running agent)" />
        </Stack>
      </Paper>
    );
  }

  // A proposal waits for the user to start it, even with a question on it: the alert below comes first.
  if (openQuestion?.questions && !isProposal) {
    const questions = openQuestion.questions;
    return (
      <QuestionPanel
        key={openQuestion.id}
        questions={questions}
        submitting={actions.answer.isPending}
        onSubmit={(answers, note) =>
          actions.answer.mutate({ id: task.id, questionNoteId: openQuestion.id, questions, answers, message: note })
        }
      />
    );
  }

  if (task.status === 'backlog') {
    return (
      <Paper withBorder p="md">
        <Stack>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">Parked. No worker takes it until you move it to Todo.</Text>
            <Button
              size="xs"
              leftSection={<IconPlayerPlay size={14} />}
              onClick={() => actions.move.mutate({ id: task.id, status: 'todo', task })}
              loading={actions.move.isPending}
            >
              Move to Todo
            </Button>
          </Group>
          <CommentOnly actions={actions} hint="Add to the thread" />
        </Stack>
      </Paper>
    );
  }

  if (task.status === 'todo') {
    return (
      <Paper withBorder p="md">
        <Stack>
          {waiting && task.notBefore !== null && (
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm">
                Waiting until {stamp(task.notBefore)}.
                {task.scheduleId !== null && (
                  <>
                    {' '}
                    This is the next run of a repeating schedule (
                    <Anchor component={Link} to="/schedules" size="sm">
                      Schedules
                    </Anchor>
                    ).
                  </>
                )}
              </Text>
              <Button
                size="xs"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={() => actions.setNotBefore.mutate({ id: task.id, notBefore: null })}
                loading={actions.setNotBefore.isPending}
              >
                Run now
              </Button>
            </Group>
          )}
          <Text size="sm">
            {task.paused ? 'Paused to free its slot.' : 'Queued.'}{' '}
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
    if (!message.trim() || isProposal) return;
    actions.reply.mutate({ id: task.id, message, resume: true }, { onSuccess: () => setMessage('') });
  };
  const confirmRerun = () =>
    modals.openConfirmModal({
      title: 'Re-run from scratch?',
      children: (
        <Text size="sm">The next run starts a new session and does not see the earlier one, only this thread.</Text>
      ),
      labels: { confirm: 'Re-run', cancel: 'Cancel' },
      onConfirm: () => actions.rerun.mutate({ id: task.id }),
    });

  return (
    <Paper withBorder p="md">
      <Stack>
        {isProposal && (
          <Alert color="grape" variant="light" icon={<IconSparkles size={18} />} title="Proposed by an agent">
            <Group justify="space-between">
              <Text size="sm">Nothing runs until you start it.</Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  color="grape"
                  leftSection={<IconPlayerPlay size={14} />}
                  onClick={() => actions.move.mutate({ id: task.id, status: 'todo', task })}
                  loading={actions.move.isPending}
                >
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
          placeholder={
            task.sessionId
              ? 'Steer the agent: a follow-up, a correction, a new instruction…'
              : 'Instructions for the run…'
          }
        />
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconCheck size={16} />}
              onClick={() => actions.done.mutate({ id: task.id })}
              disabled={task.status === 'done'}
              loading={actions.done.isPending}
            >
              Mark done
            </Button>
            <Menu position="top-start">
              <Menu.Target>
                <Button variant="subtle" color="gray" rightSection={<IconChevronDown size={14} />}>
                  More
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconRefresh size={14} />} onClick={confirmRerun} disabled={isProposal}>
                  Re-run fresh
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconMessage size={14} />}
                  disabled={!message.trim()}
                  onClick={() =>
                    actions.reply.mutate({ id: task.id, message, resume: false }, { onSuccess: () => setMessage('') })
                  }
                >
                  Comment without continuing
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconArchive size={14} />}
                  color="red"
                  onClick={() => actions.close.mutate({ id: task.id, closed: true })}
                >
                  Close
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed" visibleFrom="sm">
              <Kbd size="xs">⌘</Kbd>+<Kbd size="xs">Enter</Kbd>
            </Text>
            <Button
              leftSection={<IconPlayerPlay size={16} />}
              onClick={send}
              disabled={!message.trim() || isProposal}
              loading={actions.reply.isPending}
              title={isProposal ? 'Start the proposal first' : undefined}
            >
              {task.sessionId ? 'Send & continue' : 'Send & run'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
