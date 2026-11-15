import { PRIORITIES, type Priority } from '@agent-board/shared';
import {
  Button,
  Code,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PRIORITY_LABEL } from '../lib/priority';
import { parseRepeatRule } from '../lib/repeat';
import { errorMessage, useTRPC } from '../lib/trpc';
import { useNow } from '../lib/useNow';
import { MarkdownEditor } from './MarkdownEditor';

const WHEN_LABEL = { now: 'Now', later: 'Later', repeat: 'Repeating', backlog: 'Backlog', hold: 'Needs me' } as const;
type When = keyof typeof WHEN_LABEL;

/** A prompt, as you would type it into Claude Code. `board schedule` does the same from a terminal, in its directory. */
export function NewTaskModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [when, setWhen] = useState<When>('now');
  const [at, setAt] = useState('');
  const [rule, setRule] = useState('');
  const [times, setTimes] = useState<number | string>('');
  const [priority, setPriority] = useState<Priority>('normal');
  const create = useMutation(trpc.tasks.create.mutationOptions());

  const now = useNow(30_000);
  const start = new Date(at);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parsedRule = parseRepeatRule(rule, timezone);
  const startsLater = when === 'later' || when === 'repeat';
  const atError = startsLater && at !== '' && !(start.getTime() > now) ? 'Pick a time in the future' : undefined;
  const timesError =
    times !== '' && !(Number.isInteger(times) && Number(times) > 0) ? 'A whole number, 1 or more' : undefined;
  const ruleError = when === 'repeat' && rule.trim() !== '' && 'error' in parsedRule ? parsedRule.error : undefined;
  const repeat = 'error' in parsedRule ? undefined : parsedRule;
  const ready =
    input.trim() !== '' &&
    (when !== 'later' || (at !== '' && atError === undefined)) &&
    (when !== 'repeat' || (repeat !== undefined && atError === undefined && timesError === undefined));
  const submit = () => {
    if (!ready || create.isPending) return;
    const repeating = repeat && {
      ...repeat,
      ...(at !== '' ? { at: start } : {}),
      ...(times !== '' ? { times: Number(times) } : {}),
    };
    const payload = when === 'later' ? { at: start } : when === 'repeat' ? repeating : when;
    if (payload === undefined) return;
    create.mutate(
      { title, input, when: payload, priority },
      {
        onSuccess: (task) => {
          setTitle('');
          setInput('');
          setPriority('normal');
          setAt('');
          setRule('');
          setTimes('');
          onClose();
          navigate(`/t/${task.id}`);
        },
      },
    );
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New task" size="lg">
      <Stack>
        <MarkdownEditor
          label="Prompt"
          value={input}
          onChange={setInput}
          minRows={6}
          onSubmit={submit}
          autoFocus
          placeholder={'/review-pr 17741\n\nor any instruction, as you would type it into Claude Code'}
        />
        <Text size="xs" c="dimmed" mt={-8}>
          A leading <Code>/skill</Code> picks the lane. It runs in the default directory of whichever machine takes it;
          to run it in a particular directory, use <Code>board schedule</Code> there.
        </Text>
        <TextInput
          label="Title"
          placeholder="Defaults to the prompt's first line"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <div>
          <Text size="sm" fw={500} mb={4}>
            Priority
          </Text>
          <SegmentedControl
            fullWidth
            value={priority}
            onChange={(value) => setPriority(value as Priority)}
            data={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
          />
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            When
          </Text>
          <Select
            aria-label="When"
            allowDeselect={false}
            value={when}
            onChange={(value) => value && setWhen(value as When)}
            data={Object.entries(WHEN_LABEL).map(([value, label]) => ({ value, label }))}
          />
          {when === 'later' && (
            <TextInput
              mt="xs"
              type="datetime-local"
              aria-label="Start time"
              required
              value={at}
              onChange={(e) => setAt(e.currentTarget.value)}
              error={atError}
              description="It waits in Todo and no worker takes it before then"
            />
          )}
          {when === 'repeat' && (
            <Stack gap="xs" mt="xs">
              <TextInput
                label="Repeat"
                required
                placeholder="2h, or a cron expression such as 0 9 * * 1-5"
                value={rule}
                onChange={(e) => {
                  create.reset();
                  setRule(e.currentTarget.value);
                }}
                error={ruleError ?? (create.error ? errorMessage(create.error) : undefined)}
                description={`An interval (30m, 2h, 1d, 1w) or 5 cron fields, read in ${timezone}`}
              />
              <TextInput
                type="datetime-local"
                label="First run"
                value={at}
                onChange={(e) => setAt(e.currentTarget.value)}
                error={atError}
                description="Default: now"
              />
              <NumberInput
                label="Number of runs"
                min={1}
                allowDecimal={false}
                allowNegative={false}
                value={times}
                onChange={setTimes}
                error={timesError}
                description="Default: it repeats until you delete it"
              />
              <Text size="xs" c="dimmed">
                One pending card is on the board at a time; the next appears when it is started, moved or closed.
              </Text>
            </Stack>
          )}
        </div>
        <Group justify="flex-end">
          <Button onClick={submit} disabled={!ready} loading={create.isPending}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
