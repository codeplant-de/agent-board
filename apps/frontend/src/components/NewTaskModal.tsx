import { PRIORITIES, type Priority } from '@agent-board/shared';
import { Button, Checkbox, Code, Group, Modal, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PRIORITY_LABEL } from '../lib/priority';
import { useTRPC } from '../lib/trpc';
import { MarkdownEditor } from './MarkdownEditor';

/** A prompt, as you would type it into Claude Code. `board schedule` does the same from a terminal, in its directory. */
export function NewTaskModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [start, setStart] = useState(true);
  const [priority, setPriority] = useState<Priority>('normal');
  const create = useMutation(trpc.tasks.create.mutationOptions());

  const ready = input.trim() !== '';
  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { title, input, start, priority },
      {
        onSuccess: (task) => {
          setTitle('');
          setInput('');
          setPriority('normal');
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
        <Group justify="space-between">
          <Checkbox
            label="Queue it now"
            description="Otherwise it waits in Needs me"
            checked={start}
            onChange={(e) => setStart(e.currentTarget.checked)}
          />
          <Button onClick={submit} disabled={!ready} loading={create.isPending}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
