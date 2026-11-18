import { AGENT_NAME_RULE, isAgentName, PRIORITIES, type Priority } from '@agent-board/shared';
import {
  Button,
  Checkbox,
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
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { skillsFor } from '../lib/catalog';
import { DEFAULT_MODEL } from '../lib/model';
import { PRIORITY_LABEL } from '../lib/priority';
import { parseRepeatRule } from '../lib/repeat';
import { errorMessage, useTRPC } from '../lib/trpc';
import { useNow } from '../lib/useNow';
import { DirectorySelect } from './DirectorySelect';
import { MarkdownEditor } from './MarkdownEditor';
import { useDirectoryChoices } from './useDirectoryChoices';
import { useModelOptions } from './useModelOptions';

const WHEN_LABEL = { now: 'Now', later: 'Later', repeat: 'Repeating', backlog: 'Backlog', hold: 'Needs me' } as const;
type When = keyof typeof WHEN_LABEL;

interface Props {
  opened: boolean;
  onClose: () => void;
  /** Text to start from; read when the modal mounts, so give a new one a new `key`. */
  initial?: { title: string; input: string };
  /** After the task exists. */
  onCreated?: () => void;
}

/** A prompt, as you would type it into Claude Code, and optionally the directory of a machine it runs in. */
export function NewTaskModal({ opened, onClose, initial, onCreated }: Props) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [input, setInput] = useState(initial?.input ?? '');
  const [when, setWhen] = useState<When>('now');
  const [at, setAt] = useState('');
  const [rule, setRule] = useState('');
  const [times, setTimes] = useState<number | string>('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [autoDone, setAutoDone] = useState(false);
  const [directory, setDirectory] = useState<string | null>(null);
  const [agent, setAgent] = useState('');
  const directories = useDirectoryChoices();
  const catalogs = useQuery(trpc.machines.catalogs.queryOptions());
  const create = useMutation(trpc.tasks.create.mutationOptions());

  const now = useNow(30_000);
  const start = new Date(at);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parsedRule = parseRepeatRule(rule, timezone);
  const place = directories.choices.find(({ value }) => value === directory);
  const skills = useMemo(
    () => skillsFor(catalogs.data ?? [], { machine: place?.machine, workdir: place?.path }),
    [catalogs.data, place?.machine, place?.path],
  );
  const models = useModelOptions(place?.machine, model);
  const agentName = agent.trim();
  const agentError = agentName !== '' && !isAgentName(agentName) ? `Use ${AGENT_NAME_RULE}` : undefined;
  const startsLater = when === 'later' || when === 'repeat';
  const atError = startsLater && at !== '' && !(start.getTime() > now) ? 'Pick a time in the future' : undefined;
  const timesError =
    times !== '' && !(Number.isInteger(times) && Number(times) > 0) ? 'A whole number, 1 or more' : undefined;
  const ruleError = when === 'repeat' && rule.trim() !== '' && 'error' in parsedRule ? parsedRule.error : undefined;
  const repeat = 'error' in parsedRule ? undefined : parsedRule;
  const ready =
    input.trim() !== '' &&
    agentError === undefined &&
    (when !== 'later' || (at !== '' && atError === undefined)) &&
    (when !== 'repeat' || (repeat !== undefined && atError === undefined && timesError === undefined));
  const submit = () => {
    if (!ready || create.isPending) return;
    const schedule = repeat && {
      ...repeat,
      ...(at !== '' ? { at: start } : {}),
      ...(times !== '' ? { times: Number(times) } : {}),
    };
    const payload = when === 'later' ? { at: start } : when === 'repeat' ? schedule : when;
    if (payload === undefined) return;
    create.mutate(
      {
        title,
        input,
        when: payload,
        priority,
        ...(model === DEFAULT_MODEL ? {} : { model }),
        ...(autoDone ? { autoDone } : {}),
        ...(place === undefined ? {} : { place: { machine: place.machine, workdir: place.path } }),
        ...(agentName === '' ? {} : { agent: agentName }),
      },
      {
        onSuccess: (task) => {
          onCreated?.();
          setTitle('');
          setInput('');
          setPriority('normal');
          setWhen('now');
          setModel(DEFAULT_MODEL);
          setAutoDone(false);
          setDirectory(null);
          setAgent('');
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
          skills={skills}
          placeholder={'/review-pr 17741\n\nor any instruction, as you would type it into Claude Code'}
        />
        <Text size="xs" c="dimmed" mt={-8}>
          A leading <Code>/skill</Code> picks the lane; type <Code>/</Code> to pick one from the skills of the chosen
          machine and directory. Without a working directory it runs in the default directory of whichever machine takes
          it.
        </Text>
        <DirectorySelect
          label="Working directory"
          directories={directories}
          value={directory}
          onChange={setDirectory}
        />
        <TextInput
          label="Agent"
          placeholder="Runs as you, with your permissions"
          value={agent}
          onChange={(e) => setAgent(e.currentTarget.value)}
          error={agentError}
          description="The name of an agent in the config.json of the machine that runs it: only its tools and lists, never asking. A machine without it does not run the task. The board cannot read the name."
        />
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
        <Select
          label="Model"
          allowDeselect={false}
          value={model}
          onChange={(value) => value && setModel(value)}
          data={models.options}
          description={
            models.fromCatalog
              ? 'The models claude lists on the chosen machine, or on any machine. Default is the model claude picks on the machine that runs it'
              : 'Default is the model claude picks on the machine that runs it'
          }
        />
        <Checkbox
          label="Agent may mark it done"
          description="When it judges every acceptance criterion met and nothing is left for you, the agent moves the task to Done instead of Needs me. A repeat gives this to each task it makes."
          checked={autoDone}
          onChange={(event) => setAutoDone(event.currentTarget.checked)}
        />
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
