import { Alert, Button, Code, Group, Paper, Spoiler, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconSparkles, IconWand } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { polishState } from '../lib/polish';
import { ago, stamp } from '../lib/time';
import { useTRPC, type BoardTask, type ThreadNote } from '../lib/trpc';
import { confirmApply } from './confirmApply';

/**
 * An agent's polished title and prompt for this task's parent, shown as plain text. Applying it is the user's act: the
 * browser shows it whole, and only then seals it as theirs.
 */
export function PolishItem({ note, task, parent }: { note: ThreadNote; task: BoardTask; parent: BoardTask | null }) {
  const trpc = useTRPC();
  const apply = useMutation(trpc.tasks.applyPolish.mutationOptions());
  const state = polishState(task, parent, note);
  const at = new Date(note.createdAt);

  return (
    <Paper withBorder p="sm" style={{ borderLeft: '3px solid var(--mantine-color-grape-6)' }} data-testid="polish">
      <Group gap="xs" mb="xs">
        <ThemeIcon size="sm" variant="light" color="grape">
          <IconSparkles size={14} />
        </ThemeIcon>
        <Text size="xs" fw={600}>
          Polished prompt
        </Text>
        <Text size="xs" c="dimmed" title={stamp(at)}>
          · {ago(at)}
        </Text>
      </Group>
      {state.usable ? (
        <Stack gap="xs">
          <Text size="sm" fw={500} className="wrap-anywhere">
            {state.rewrite.title}
          </Text>
          <Spoiler maxHeight={200} showLabel="Show all" hideLabel="Show less">
            <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {state.rewrite.prompt}
            </Code>
          </Spoiler>
          <Group justify="flex-end">
            <Button
              size="xs"
              color="grape"
              className="truncate-flex"
              leftSection={<IconWand size={14} />}
              loading={apply.isPending}
              onClick={() =>
                confirmApply({ targetTitle: state.target.title, rewrite: state.rewrite }, () =>
                  apply.mutate({
                    polishId: task.id,
                    target: { ...state.target, agent: state.target.agent ?? null },
                    rewrite: state.rewrite,
                  }),
                )
              }
            >
              Apply to {state.target.title}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Alert color="orange" variant="light" title="This polished prompt cannot be applied">
          <Text size="sm">{state.reason}</Text>
        </Alert>
      )}
    </Paper>
  );
}
