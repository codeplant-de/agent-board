import { PRIORITIES, type Priority } from '@agent-board/shared';
import { Button, Checkbox, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PRIORITY_LABEL } from '../lib/priority';
import { useTRPC } from '../lib/trpc';
import { MarkdownEditor } from './MarkdownEditor';

export function NewTaskModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const labels = useQuery({ ...trpc.labels.list.queryOptions(), enabled: opened });
  const [label, setLabel] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [start, setStart] = useState(true);
  const [priority, setPriority] = useState<Priority>('normal');
  const create = useMutation(trpc.tasks.create.mutationOptions());

  useEffect(() => {
    if (opened && label === null && labels.data?.[0]) setLabel(labels.data[0].name);
  }, [opened, label, labels.data]);

  const description = labels.data?.find((l) => l.name === label)?.description;
  const ready = label !== null && title.trim() !== '';
  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { label, title, input, start, priority },
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
        <Select
          label="Type"
          description="The label picks the worker. A machine runs it only if its config has the label."
          data={(labels.data ?? []).map((l) => ({ value: l.name, label: l.name }))}
          value={label}
          onChange={setLabel}
          allowDeselect={false}
          nothingFoundMessage="No labels yet: run `board setup` on a machine"
        />
        {description && (
          <Text size="xs" c="dimmed" mt={-8}>
            {description}
          </Text>
        )}
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
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus />
        <MarkdownEditor
          label="What to do"
          value={input}
          onChange={setInput}
          minRows={6}
          onSubmit={submit}
          placeholder={'Markdown. For a PR review, the first line is the PR URL.'}
        />
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
