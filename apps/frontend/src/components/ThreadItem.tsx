import { formatAnswers, UNREADABLE_TEXT, type Question } from '@agent-board/shared';
import { Badge, Group, Paper, Spoiler, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconCircleDot,
  IconEye,
  IconLockOff,
  IconMessageQuestion,
  IconRobot,
  IconServer,
  IconUser,
} from '@tabler/icons-react';
import { answerTo } from '../lib/answers';
import { ago, clock, stamp } from '../lib/time';
import type { ThreadNote } from '../lib/trpc';
import { isWatchNote, splitWatchNote } from '../lib/watches';
import { Markdown } from './Markdown';

/** Where a message to a running agent stands: not yet handed over, or delivered. */
function DeliveryState({ note }: { note: ThreadNote }) {
  if (note.pending)
    return (
      <Badge size="xs" color="gray" variant="light" tt="none">
        Waiting for the agent
      </Badge>
    );
  if (note.deliveredAt === undefined) return null;
  return (
    <Text size="xs" c="dimmed" title={stamp(new Date(note.deliveredAt))}>
      · Delivered
    </Text>
  );
}

function Meta({ who, by, at }: { who: string; by: string | null; at: Date }) {
  return (
    <Group gap={6}>
      <Text size="xs" fw={600}>
        {who}
      </Text>
      {by && (
        <Text size="xs" c="dimmed">
          {by}
        </Text>
      )}
      <Text size="xs" c="dimmed" title={stamp(at)}>
        · {ago(at)}
      </Text>
    </Group>
  );
}

/** A note this browser could not open: never shown as what anyone wrote. */
function UnreadableNote({ note }: { note: ThreadNote }) {
  const who = { user: 'You', agent: 'Agent', system: 'System', server: 'Board', unknown: 'Unknown' }[note.author];
  return (
    <Paper withBorder p="sm" style={{ borderStyle: 'dashed' }}>
      <Group gap="xs" mb={6}>
        <ThemeIcon size="sm" variant="light" color="gray">
          <IconLockOff size={14} />
        </ThemeIcon>
        <Meta who={who} by={note.by} at={new Date(note.createdAt)} />
      </Group>
      <Text size="sm" c="dimmed" fs="italic">
        {note.duplicateId ? 'The board sent several notes with this id, so none of them is shown.' : UNREADABLE_TEXT}
      </Text>
    </Paper>
  );
}

/** Long agent notes fold; the first screenful is usually the summary. */
function Folded({ text }: { text: string }) {
  if (text.length < 1500) return <Markdown>{text}</Markdown>;
  return (
    <Spoiler maxHeight={320} showLabel="Show all" hideLabel="Show less">
      <Markdown>{text}</Markdown>
    </Spoiler>
  );
}

function QuestionList({ questions, answered }: { questions: Question[]; answered: ThreadNote | undefined }) {
  return (
    <Stack gap="sm">
      {questions.map((question, index) => {
        const answer = answered?.answers?.[index];
        return (
          <Stack key={index} gap={4}>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Badge variant="light" tt="none" style={{ flexShrink: 0 }}>
                {question.header}
              </Badge>
              <Text size="sm" className="wrap-anywhere">
                {question.question}
              </Text>
            </Group>
            <Group gap={6} pl="xs">
              {question.options.map((option) => {
                const chosen = answer?.selected.includes(option.label) ?? false;
                return (
                  <Badge
                    key={option.label}
                    tt="none"
                    variant={chosen ? 'filled' : 'default'}
                    color={chosen ? 'indigo' : undefined}
                    title={option.description}
                  >
                    {option.label}
                    {option.recommended ? ' ★' : ''}
                  </Badge>
                );
              })}
              {answer?.other && (
                <Badge tt="none" variant="filled" color="indigo">
                  “{answer.other}”
                </Badge>
              )}
            </Group>
          </Stack>
        );
      })}
    </Stack>
  );
}

interface Props {
  note: ThreadNote;
  thread: ThreadNote[];
  /** The id of the question note the task waits on. An unanswered question that is not this one was dropped. */
  openQuestionId?: string | undefined;
}

/**
 * An event the board server wrote itself, one of its fixed texts: set apart from the notes of your machines, which can
 * say anything and are shown as "system" notes.
 */
function BoardEvent({ note }: { note: ThreadNote }) {
  const at = new Date(note.createdAt);
  return (
    <Group gap="xs" wrap="nowrap" align="center" px="xs" data-testid="board-event">
      <IconServer size={14} color="var(--mantine-color-blue-6)" style={{ flexShrink: 0 }} />
      <Badge
        size="xs"
        variant="light"
        color="blue"
        tt="none"
        title="Written by the board server itself, not by your machines or you"
      >
        Board
      </Badge>
      <Text size="xs" c="blue.8">
        {note.text}{' '}
        <Text span size="xs" c="dimmed" title={stamp(at)}>
          · {ago(at)}
        </Text>
      </Text>
    </Group>
  );
}

/** What the CLI writes when a watch reports: a compact row, the fenced text behind a disclosure. Plain text, not markdown. */
function WatchEvent({ note }: { note: ThreadNote }) {
  const at = new Date(note.createdAt);
  const { title, body } = splitWatchNote(note.text);
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start" px="xs" data-testid="watch-event">
      <IconEye size={14} color="var(--mantine-color-dimmed)" style={{ marginTop: 3, flexShrink: 0 }} />
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text size="xs" c="dimmed">
          {title}{' '}
          <Text span size="xs" c="dimmed" title={stamp(at)}>
            · {clock(at)}
          </Text>
        </Text>
        {body && (
          <Spoiler maxHeight={0} showLabel="Details" hideLabel="Hide" styles={{ control: { fontSize: 12 } }}>
            <Paper withBorder p="xs">
              <Text size="xs" ff="monospace" className="wrap-anywhere" style={{ whiteSpace: 'pre-wrap' }}>
                {body}
              </Text>
            </Paper>
          </Spoiler>
        )}
      </Stack>
    </Group>
  );
}

export function ThreadItem({ note, thread, openQuestionId }: Props) {
  const at = new Date(note.createdAt);
  if (note.unreadable) return <UnreadableNote note={note} />;
  if (note.author === 'server') return <BoardEvent note={note} />;
  if (isWatchNote(note)) return <WatchEvent note={note} />;
  if (note.author === 'system') {
    const [raw = '', ...rest] = note.text.trim().split('\n');
    const more = rest.join('\n').trim();
    // The dispatcher's start marker, "agent-board: started <iso> (<label>, <machine>, unit …)", in words.
    const start = /^agent-board: started \S+ \(([^,]+), ([^,]+),/.exec(raw);
    const first = start ? `Run started on ${start[2]} (${start[1]})` : raw;
    return (
      <Group gap="xs" wrap="nowrap" align="flex-start" px="xs">
        <IconCircleDot size={14} color="var(--mantine-color-dimmed)" style={{ marginTop: 3, flexShrink: 0 }} />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="xs" c="dimmed" title={start ? raw : undefined}>
            {first}{' '}
            <Text span size="xs" c="dimmed" title={stamp(at)}>
              · {note.by ? `${note.by} · ` : ''}
              {ago(at)}
            </Text>
          </Text>
          {more && (
            <Spoiler maxHeight={0} showLabel="Details" hideLabel="Hide" styles={{ control: { fontSize: 12 } }}>
              <Paper withBorder p="xs">
                <Markdown>{more}</Markdown>
              </Paper>
            </Spoiler>
          )}
        </Stack>
      </Group>
    );
  }

  if (note.kind === 'question' && note.questions) {
    const answered = answerTo(thread, note);
    const isOpen = !answered && note.id === openQuestionId;
    return (
      <Paper withBorder p="sm" style={{ borderLeft: '3px solid var(--mantine-color-orange-6)' }}>
        <Group gap="xs" mb="xs">
          <ThemeIcon size="sm" variant="light" color="orange">
            <IconMessageQuestion size={14} />
          </ThemeIcon>
          <Meta who="Agent asked" by={note.by} at={at} />
          {isOpen && (
            <Badge size="xs" color="orange">
              open
            </Badge>
          )}
          {!answered && !isOpen && (
            <Badge size="xs" color="gray" variant="light">
              not answered
            </Badge>
          )}
        </Group>
        {isOpen ? (
          <Text size="sm" c="dimmed">
            {note.questions.map((q) => q.header).join(' · ')}: answer below.
          </Text>
        ) : (
          <QuestionList questions={note.questions} answered={answered} />
        )}
        {note.text.trim() && (
          <div style={{ marginTop: 8 }}>
            <Markdown>{note.text}</Markdown>
          </div>
        )}
      </Paper>
    );
  }

  const fromUser = note.author === 'user';
  const questions = note.kind === 'answer' ? note.questions : undefined;
  return (
    <Paper
      withBorder
      p="sm"
      ml={fromUser ? { base: 0, sm: 48 } : 0}
      mr={fromUser ? 0 : { base: 0, sm: 48 }}
      bg={fromUser ? 'var(--mantine-color-indigo-light)' : undefined}
    >
      <Group gap="xs" mb={6}>
        <ThemeIcon size="sm" variant="light" color={fromUser ? 'indigo' : 'gray'}>
          {fromUser ? <IconUser size={14} /> : <IconRobot size={14} />}
        </ThemeIcon>
        <Meta
          who={fromUser ? (note.kind === 'answer' ? 'You answered' : 'You') : 'Agent'}
          by={fromUser ? null : note.by}
          at={at}
        />
        {fromUser && <DeliveryState note={note} />}
      </Group>
      {note.kind === 'answer' && note.answers && (
        <Text size="sm" className="wrap-anywhere" style={{ whiteSpace: 'pre-wrap' }} mb={note.text.trim() ? 6 : 0}>
          {formatAnswers(questions, note.answers)}
        </Text>
      )}
      {note.text.trim() && <Folded text={note.text} />}
      {note.suggestion && (
        <Text size="xs" c="dimmed" fs="italic" mt={6} className="wrap-anywhere" style={{ whiteSpace: 'pre-wrap' }}>
          Suggested reply: {note.suggestion}
        </Text>
      )}
    </Paper>
  );
}
