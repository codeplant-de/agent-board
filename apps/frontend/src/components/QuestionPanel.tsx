import type { Answer, Question } from '@agent-board/shared';
import { Badge, Button, Checkbox, Group, Kbd, Paper, Radio, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconMessageQuestion, IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import { MarkdownEditor } from './MarkdownEditor';

interface Draft {
  selected: string[];
  other: string;
}

const initial = (questions: Question[]): Draft[] =>
  questions.map((q) => ({ selected: q.options.filter((o) => o.recommended).map((o) => o.label), other: '' }));

export const isAnswered = (draft: Draft): boolean => draft.selected.length > 0 || draft.other.trim() !== '';

export function toAnswers(drafts: Draft[]): Answer[] {
  return drafts.map((d) =>
    d.other.trim() ? { selected: d.selected, other: d.other.trim() } : { selected: d.selected },
  );
}

interface Props {
  questions: Question[];
  submitting: boolean;
  onSubmit: (answers: Answer[], message: string) => void;
}

/**
 * The agent's open question, answered like AskUserQuestion in the terminal: option cards (the recommended one
 * preselected), an "Other" field per question, number keys to pick, ⌘/Ctrl+Enter to send.
 */
export function QuestionPanel({ questions, submitting, onSubmit }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => initial(questions));
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState('');
  const ready = drafts.every((draft, index) => questions[index]?.multiSelect || isAnswered(draft));

  const update = (index: number, change: Partial<Draft>) =>
    setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...change } : d)));

  const pick = (index: number, label: string) => {
    const question = questions[index];
    const draft = drafts[index];
    if (!question || !draft) return;
    setActive(index);
    if (question.multiSelect) {
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label];
      update(index, { selected });
    } else {
      update(index, { selected: [label] });
      // A single choice is made: go on to the next question.
      if (index < questions.length - 1) setActive(index + 1);
    }
  };

  const submit = () => {
    if (ready && !submitting) onSubmit(toAnswers(drafts), message);
  };

  useHotkeys([
    ...[1, 2, 3, 4].map(
      (n) =>
        [
          String(n),
          () => {
            const option = questions[active]?.options[n - 1];
            if (option) pick(active, option.label);
          },
        ] as [string, () => void],
    ),
    ['mod+Enter', submit],
  ]);

  return (
    <Paper withBorder p="md" radius="md" style={{ borderColor: 'var(--mantine-color-orange-5)' }}>
      <Stack gap="lg">
        <Group gap="xs">
          <IconMessageQuestion size={20} color="var(--mantine-color-orange-6)" />
          <Text fw={600}>The agent is waiting for your answer</Text>
        </Group>
        {questions.map((question, index) => {
          const draft = drafts[index]!;
          return (
            <Stack
              key={index}
              gap="xs"
              onFocusCapture={() => setActive(index)}
              onMouseDown={() => setActive(index)}
              p="xs"
              style={{
                borderRadius: 'var(--mantine-radius-md)',
                outline:
                  questions.length > 1 && active === index ? '1px solid var(--mantine-color-indigo-3)' : undefined,
              }}
            >
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Badge variant="light" tt="none" style={{ flexShrink: 0 }}>
                  {question.header}
                </Badge>
                <Text size="sm" fw={500}>
                  {question.question}
                  {question.multiSelect && (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      (pick any)
                    </Text>
                  )}
                </Text>
              </Group>
              <SimpleGrid
                cols={{ base: 1, sm: question.options.length > 2 ? 2 : question.options.length }}
                spacing="xs"
              >
                {question.options.map((option, optionIndex) => {
                  const chosen = draft.selected.includes(option.label);
                  const Card = question.multiSelect ? Checkbox.Card : Radio.Card;
                  return (
                    <Card
                      key={option.label}
                      value={option.label}
                      checked={chosen}
                      onClick={() => pick(index, option.label)}
                      radius="md"
                      p="sm"
                      style={{
                        borderColor: chosen ? 'var(--mantine-color-indigo-5)' : undefined,
                        background: chosen ? 'var(--mantine-color-indigo-light)' : undefined,
                      }}
                    >
                      <Group wrap="nowrap" align="flex-start" gap="sm">
                        {question.multiSelect ? (
                          <Checkbox.Indicator checked={chosen} />
                        ) : (
                          <Radio.Indicator checked={chosen} />
                        )}
                        <div style={{ flex: 1 }}>
                          <Group gap={6} justify="space-between" wrap="nowrap">
                            <Text size="sm" fw={500}>
                              {option.label}
                            </Text>
                            <Group gap={4} wrap="nowrap">
                              {option.recommended && (
                                <Badge size="xs" color="teal" variant="light">
                                  Recommended
                                </Badge>
                              )}
                              {active === index && <Kbd size="xs">{optionIndex + 1}</Kbd>}
                            </Group>
                          </Group>
                          {option.description && (
                            <Text size="xs" c="dimmed" mt={2}>
                              {option.description}
                            </Text>
                          )}
                        </div>
                      </Group>
                    </Card>
                  );
                })}
              </SimpleGrid>
              <TextInput
                size="xs"
                placeholder={
                  question.multiSelect || draft.selected.length === 0 ? 'Other…' : 'Other… (added to your choice)'
                }
                value={draft.other}
                onChange={(event) => update(index, { other: event.currentTarget.value })}
              />
            </Stack>
          );
        })}
        <MarkdownEditor
          value={message}
          onChange={setMessage}
          minRows={2}
          onSubmit={submit}
          placeholder="Anything else the agent should know (optional)"
        />
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {questions.length > 1 ? 'Number keys pick in the highlighted question. ' : 'Number keys pick an option. '}
            <Kbd size="xs">⌘</Kbd>+<Kbd size="xs">Enter</Kbd> sends.
          </Text>
          <Button leftSection={<IconPlayerPlay size={16} />} onClick={submit} disabled={!ready} loading={submitting}>
            Answer &amp; continue
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
