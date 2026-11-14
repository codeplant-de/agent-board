import { PRIORITIES, type Priority } from '@agent-board/shared';
import { Button, Code, Group, Modal, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PRIORITY_LABEL } from '../lib/priority';
import { useTRPC } from '../lib/trpc';
import { useNow } from '../lib/useNow';
import { MarkdownEditor } from './MarkdownEditor';

const WHEN_LABEL = { now: 'Now', later: 'Later', backlog: 'Backlog', hold: 'Needs me' } as const;
type When = keyof typeof WHEN_LABEL;

/** A prompt, as you would type it into Claude Code. `board schedule` does the same from a terminal, in its directory. */
export function NewTaskModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [when, setWhen] = useState<When>('now');
  const [at, setAt] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const create = useMutation(trpc.tasks.create.mutationOptions());

  const now = useNow(30_000);
  const start = new Date(at);
  const atError = when === 'later' && at !== '' && !(start.getTime() > now) ? 'Pick a time in the future' : undefined;
  const ready = input.trim() !== '' && (when !== 'later' || (at !== '' && atError === undefined));
  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { title, input, when: when === 'later' ? { at: start } : when, priority },
      {
        onSuccess: (task) => {
          setTitle('');
          setInput('');
          setPriority('normal');
          setAt('');
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
          <SegmentedControl
            fullWidth
            value={when}
            onChange={(value) => setWhen(value as When)}
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
