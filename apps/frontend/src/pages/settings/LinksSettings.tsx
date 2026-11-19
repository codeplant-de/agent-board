import {
  linkRuleProblem,
  MAX_LINK_PATTERN_CHARS,
  MAX_LINK_RULES,
  MAX_LINK_URL_CHARS,
  type LinkRule,
} from '@agent-board/shared';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useMemo, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { QueryStatus } from '../../components/QueryStatus';
import { LinkRulesContext } from '../../lib/linkRulesContext';
import { ago, stamp } from '../../lib/time';
import { useTRPC } from '../../lib/trpc';

interface DraftRule {
  key: string;
  pattern: string;
  url: string;
  ignoreCase: boolean;
}

const PATTERN_EXAMPLE = 'sc-(\\d+)';
const URL_EXAMPLE = 'https://app.shortcut.com/acme/story/$1';
const TRY_TEXT = 'Fixed in sc-72195, see also `sc-1` in code and [sc-2](https://example.com).';

const asRule = ({ pattern, url, ignoreCase }: DraftRule): LinkRule => ({
  pattern,
  url,
  ...(ignoreCase ? { flags: 'i' as const } : {}),
});

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** What is wrong with the pattern and with the URL of a row; a field that is still empty shows nothing yet. */
function fieldProblems(draft: DraftRule): { pattern?: string; url?: string } {
  const rule = asRule(draft);
  const pattern = draft.pattern === '' ? undefined : linkRuleProblem({ ...rule, url: 'https://example.com' });
  const url = draft.url === '' ? undefined : linkRuleProblem({ pattern: 'a', url: draft.url });
  return {
    ...(pattern === undefined ? {} : { pattern: sentence(pattern) }),
    ...(url === undefined ? {} : { url: sentence(url) }),
  };
}

const isConflict = (error: unknown): boolean =>
  error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === 'CONFLICT';

/** The rules that turn text into links in the markdown of the browser; they live on the board sealed, and only this browser reads them. */
export function LinksSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const links = useQuery(trpc.links.get.queryOptions());
  const save = useMutation(trpc.links.set.mutationOptions());
  // The version the edits start from: a refetch that finds a newer one must not let a save through over it.
  const [edit, setEdit] = useState<{ base: number; rows: DraftRule[] }>();
  const [added, setAdded] = useState(0);
  const [tryText, setTryText] = useState(TRY_TEXT);

  const stored = links.data;
  const unreadable = stored !== undefined && stored !== null && stored.rules === null;
  const rows = useMemo<DraftRule[]>(
    () =>
      edit?.rows ??
      (stored?.rules ?? []).map((rule, index) => ({
        key: `saved-${stored?.version}-${index}`,
        pattern: rule.pattern,
        url: rule.url,
        ignoreCase: rule.flags === 'i',
      })),
    [edit, stored],
  );
  const problems = rows.map(fieldProblems);
  const invalid = rows.some((row) => linkRuleProblem(asRule(row)) !== undefined);
  const draftRules = useMemo(() => rows.map(asRule).filter((rule) => linkRuleProblem(rule) === undefined), [rows]);

  const base = edit?.base ?? stored?.version ?? 0;
  const edited = (next: DraftRule[]) => setEdit({ base, rows: next });
  const change = (key: string, patch: Partial<DraftRule>) =>
    edited(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const add = () => {
    setAdded(added + 1);
    edited([...rows, { key: `new-${added}`, pattern: '', url: '', ignoreCase: false }]);
  };

  const onSave = () =>
    save.mutate(
      { rules: rows.map(asRule), expectedVersion: base },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: trpc.links.get.queryOptions().queryKey });
          setEdit(undefined);
        },
      },
    );

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Links</Title>
          <Text size="sm" c="dimmed">
            A rule turns text into a link wherever the board shows markdown: prompts, comments, answers and transcripts.
            The pattern is a regular expression and the URL says where the link goes: <Code>$1</Code> to <Code>$9</Code>{' '}
            and <Code>{'$<name>'}</Code> insert what a capture group matched, <Code>$&amp;</Code> the whole match and{' '}
            <Code>$$</Code> a dollar sign. With <Code>{PATTERN_EXAMPLE}</Code> and <Code>{URL_EXAMPLE}</Code>,
            &quot;sc-72195&quot; links to story 72195. Text in code and text that is already a link stays as it is. Your
            agents never see the rules: only this browser reads them.
          </Text>
        </div>
        <QueryStatus query={links} what="link rules" />
        {unreadable && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            The saved rules cannot be read with your key, so none apply. Saving replaces them.
          </Alert>
        )}
        {isConflict(save.error) && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            The rules changed somewhere else since you opened this page. Reload the page to see them, then make your
            change again.
          </Alert>
        )}
        {stored && (
          <Text size="sm">
            Version {stored.version}, saved{' '}
            {stored.updatedAt === '' ? 'at an unknown time' : `${stamp(stored.updatedAt)} (${ago(stored.updatedAt)})`}.
          </Text>
        )}
        {links.data !== undefined && rows.length === 0 && (
          <Text size="sm" c="dimmed">
            No rules yet.
          </Text>
        )}
        {rows.map((row, index) => (
          <Group key={row.key} align="flex-start" wrap="nowrap" gap="xs">
            <TextInput
              flex={1}
              aria-label={`Pattern of rule ${index + 1}`}
              placeholder={PATTERN_EXAMPLE}
              value={row.pattern}
              maxLength={MAX_LINK_PATTERN_CHARS}
              error={problems[index]?.pattern}
              onChange={(event) => change(row.key, { pattern: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
            <TextInput
              flex={2}
              aria-label={`URL of rule ${index + 1}`}
              placeholder={URL_EXAMPLE}
              value={row.url}
              maxLength={MAX_LINK_URL_CHARS}
              error={problems[index]?.url}
              onChange={(event) => change(row.key, { url: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
            <Checkbox
              mt={8}
              label="Ignore case"
              checked={row.ignoreCase}
              onChange={(event) => change(row.key, { ignoreCase: event.currentTarget.checked })}
            />
            <ActionIcon
              mt={4}
              variant="subtle"
              color="red"
              aria-label={`Remove rule ${index + 1}`}
              onClick={() => edited(rows.filter(({ key }) => key !== row.key))}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlus size={14} />}
            disabled={links.data === undefined || rows.length >= MAX_LINK_RULES}
            onClick={add}
          >
            Add rule
          </Button>
          <Button
            size="xs"
            loading={save.isPending}
            disabled={(edit === undefined && !unreadable) || invalid || links.data === undefined}
            onClick={onSave}
          >
            Save
          </Button>
        </Group>
        <Textarea
          label="Try it"
          description="Text as the board would show it, with the rules above, saved or not."
          autosize
          minRows={2}
          value={tryText}
          onChange={(event) => setTryText(event.currentTarget.value)}
        />
        <LinkRulesContext.Provider value={draftRules}>
          <Markdown>{tryText}</Markdown>
        </LinkRulesContext.Provider>
      </Stack>
    </Paper>
  );
}
