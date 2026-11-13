import { formatAnswers, type Question } from '@agent-board/shared';
import { Badge, Group, Paper, Spoiler, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCircleDot, IconMessageQuestion, IconRobot, IconUser } from '@tabler/icons-react';
import { ago, stamp } from '../lib/time';
import type { ThreadNote } from '../lib/trpc';
import { Markdown } from './Markdown';

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
              <Text size="sm">{question.question}</Text>
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
}

export function ThreadItem({ note, thread }: Props) {
  const at = new Date(note.createdAt);
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
    const answered = thread.find((n) => n.kind === 'answer' && n.questionNoteId === note.id);
    return (
      <Paper withBorder p="sm" style={{ borderLeft: '3px solid var(--mantine-color-orange-6)' }}>
        <Group gap="xs" mb="xs">
          <ThemeIcon size="sm" variant="light" color="orange">
            <IconMessageQuestion size={14} />
          </ThemeIcon>
          <Meta who="Agent asked" by={note.by} at={at} />
          {!answered && (
            <Badge size="xs" color="orange">
              open
            </Badge>
          )}
        </Group>
        {answered ? (
          <QuestionList questions={note.questions} answered={answered} />
        ) : (
          <Text size="sm" c="dimmed">
            {note.questions.map((q) => q.header).join(' · ')}: answer below.
          </Text>
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
  const questions = note.kind === 'answer' ? thread.find((n) => n.id === note.questionNoteId)?.questions : undefined;
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
        <Meta who={fromUser ? (note.kind === 'answer' ? 'You answered' : 'You') : 'Agent'} by={fromUser ? null : note.by} at={at} />
      </Group>
      {note.kind === 'answer' && note.answers && (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} mb={note.text.trim() ? 6 : 0}>
          {formatAnswers(questions, note.answers)}
        </Text>
      )}
      {note.text.trim() && <Folded text={note.text} />}
    </Paper>
  );
}
