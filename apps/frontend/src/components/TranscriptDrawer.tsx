import { toolSummary } from '@agent-board/shared';
import {
  Alert,
  Badge,
  Box,
  Code,
  Collapse,
  Drawer,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleDot,
  IconFlag,
  IconX,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ago, stamp } from '../lib/time';
import { useTRPC, type RouterOutputs } from '../lib/trpc';
import { Markdown } from './Markdown';

type Event = RouterOutputs['transcript']['events'][number];
type ToolUse = Extract<Event, { kind: 'tool_use' }>;
type ToolResult = Extract<Event, { kind: 'tool_result' }>;

const LIVE_MS = 3_000;
const SETTLE_MS = 30_000;

function formatSize(chars: number | null | undefined): string {
  if (!chars) return 'empty';
  return chars < 1024 ? `${chars} chars` : `${(chars / 1024).toFixed(1)} KB`;
}

/** A tool call with its result: one line, expanded on click; the output loads only then. */
function ToolCall({ runId, use, result }: { runId: string; use: ToolUse; result: ToolResult | undefined }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const output = useQuery({
    ...trpc.transcript.output.queryOptions({ runId, seq: result?.seq ?? -1 }),
    enabled: open && result !== undefined && (result.outputSize ?? 0) > 0,
  });
  const status =
    result === undefined ? (
      <Loader size={12} />
    ) : result.isError ? (
      <IconX size={14} color="var(--mantine-color-red-6)" />
    ) : (
      <IconCheck size={14} color="var(--mantine-color-teal-6)" />
    );
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((o) => !o)} w="100%" py={2}>
        <Group gap={6} wrap="nowrap" align="flex-start">
          {open ? (
            <IconChevronDown size={14} style={{ marginTop: 3, flexShrink: 0 }} />
          ) : (
            <IconChevronRight size={14} style={{ marginTop: 3, flexShrink: 0 }} />
          )}
          <Box style={{ flexShrink: 0, marginTop: 2 }}>{status}</Box>
          <Badge size="sm" variant="light" color={result?.isError ? 'red' : 'gray'} tt="none" style={{ flexShrink: 0 }}>
            {use.name}
          </Badge>
          <Text
            size="xs"
            ff="monospace"
            c={result?.isError ? 'red' : undefined}
            style={{ overflowWrap: 'anywhere' }}
            lineClamp={open ? undefined : 1}
          >
            {toolSummary(use.name, use.input)}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack gap={6} pl={34} pb="xs" pt={4}>
          <Text size="xs" c="dimmed">
            Input
          </Text>
          <Code block style={{ maxHeight: 240, overflow: 'auto', fontSize: 11 }}>
            {JSON.stringify(use.input, null, 2)}
          </Code>
          <Text size="xs" c="dimmed">
            {result === undefined
              ? 'Waiting for the result…'
              : `Output · ${formatSize(result.outputSize)}${result.isError ? ' · error' : ''}`}
          </Text>
          {result !== undefined && (result.outputSize ?? 0) > 0 && (
            <Code
              block
              color={result.isError ? 'red' : undefined}
              style={{ maxHeight: 400, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}
            >
              {output.isLoading ? 'Loading…' : (output.data ?? '')}
            </Code>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

function EventRow({ runId, event, results }: { runId: string; event: Event; results: Map<string, ToolResult> }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  switch (event.kind) {
    case 'text':
      return (
        <Paper withBorder p="xs">
          <Markdown>{event.text}</Markdown>
        </Paper>
      );
    case 'thinking':
      return (
        <Box>
          <UnstyledButton onClick={() => setThinkingOpen((o) => !o)} disabled={event.text === ''}>
            <Group gap={6}>
              <IconBrain size={14} color="var(--mantine-color-dimmed)" />
              <Text size="xs" c="dimmed" fs="italic">
                Thinking{event.tokens ? ` · ~${event.tokens} tokens` : ''}
                {event.text === '' ? ' (Claude Code does not pass the text on)' : ''}
              </Text>
            </Group>
          </UnstyledButton>
          {event.text !== '' && (
            <Collapse expanded={thinkingOpen}>
              <Text size="xs" c="dimmed" fs="italic" pl={20} style={{ whiteSpace: 'pre-wrap' }}>
                {event.text}
              </Text>
            </Collapse>
          )}
        </Box>
      );
    case 'tool_use':
      return <ToolCall runId={runId} use={event} result={results.get(event.toolUseId)} />;
    case 'tool_result':
      // Shown with its call.
      return null;
    case 'note':
      return (
        <Group gap={6} wrap="nowrap" align="flex-start">
          <IconCircleDot size={12} color="var(--mantine-color-dimmed)" style={{ marginTop: 3, flexShrink: 0 }} />
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            {event.text}
          </Text>
        </Group>
      );
    case 'result':
      return (
        <Paper
          withBorder
          p="xs"
          style={{ borderColor: event.isError ? 'var(--mantine-color-red-5)' : 'var(--mantine-color-teal-5)' }}
        >
          <Group gap={6} mb={4}>
            <IconFlag size={14} />
            <Text size="xs" fw={600}>
              {event.isError ? 'Ended with an error' : 'Result'}
            </Text>
            <Text size="xs" c="dimmed">
              {[
                event.turns !== null ? `${event.turns} turns` : '',
                event.durationMs !== null ? `${Math.round(event.durationMs / 1000)} s` : '',
                event.costUsd !== null ? `$${event.costUsd.toFixed(2)}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Group>
          {event.denials.length > 0 && (
            <Alert color="red" variant="light" p="xs" mb={6} title="Refused tool calls">
              <Stack gap={2}>
                {event.denials.map((denial, i) => (
                  <Text key={i} size="xs" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
                    {denial}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
          {event.text && <Markdown>{event.text}</Markdown>}
        </Paper>
      );
  }
}

/** Everything a run did, live while it runs: the agent's text, its tool calls (output on demand), notes and results. */
export function TranscriptDrawer({
  taskId,
  opened,
  onClose,
  live,
}: {
  taskId: string;
  opened: boolean;
  onClose: () => void;
  live: boolean;
}) {
  const trpc = useTRPC();
  // The last batch of a run arrives after the task has already left Running, so polling goes on a little longer.
  const recentlyActive = (lastEventAt: Date | string | undefined) =>
    lastEventAt !== undefined && Date.now() - new Date(lastEventAt).getTime() < SETTLE_MS;
  const runs = useQuery({
    ...trpc.transcript.runs.queryOptions({ id: taskId }),
    enabled: opened,
    refetchInterval: (query) =>
      opened && (live || recentlyActive(query.state.data?.[0]?.lastEventAt)) ? LIVE_MS : false,
  });
  const [runId, setRunId] = useState<string | null>(null);
  const selected = runId ?? runs.data?.[0]?.id ?? null;
  const newest = selected !== null && selected === runs.data?.[0]?.id;
  const events = useQuery({
    ...trpc.transcript.events.queryOptions({ runId: selected ?? '' }),
    enabled: opened && selected !== null,
    refetchInterval: opened && newest && (live || recentlyActive(runs.data?.[0]?.lastEventAt)) ? LIVE_MS : false,
  });

  // When the run ends, its last events arrive with the final batch: fetch once more after live polling stops.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) {
      void runs.refetch();
      void events.refetch();
    }
    wasLive.current = live;
  }, [live, runs, events]);

  const { results, rows } = useMemo(() => {
    const results = new Map<string, ToolResult>();
    for (const event of events.data ?? []) if (event.kind === 'tool_result') results.set(event.toolUseId, event);
    return { results, rows: (events.data ?? []).filter((event) => event.kind !== 'tool_result') };
  }, [events.data]);

  // Follow new events while the reader is at the bottom.
  const viewport = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = viewport.current;
    if (el && atBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [rows.length]);

  const run = runs.data?.find((r) => r.id === selected);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title="Transcript"
      styles={{ body: { paddingBottom: 0 } }}
    >
      <Stack gap="sm">
        {runs.data && runs.data.length > 0 ? (
          <Group justify="space-between" wrap="nowrap">
            <Select
              size="xs"
              value={selected}
              onChange={setRunId}
              allowDeselect={false}
              data={runs.data.map((r, i) => ({
                value: r.id,
                label: `Run ${runs.data.length - i} · ${r.resumed ? 'resumed' : 'fresh'} · ${stamp(r.startedAt)} · ${r.machine}`,
              }))}
              style={{ flex: 1 }}
            />
            {run && (
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {run.eventCount} events · last {ago(run.lastEventAt)}
              </Text>
            )}
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            {runs.isLoading ? 'Loading…' : 'No transcript yet. Runs started after this feature record one.'}
          </Text>
        )}
        <Box
          ref={viewport}
          style={{ height: 'calc(100vh - 140px)', overflowY: 'auto', paddingRight: 8 }}
          onScroll={(event) => {
            const el = event.currentTarget;
            atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
          }}
        >
          <Stack gap={6} pb="md">
            {rows.map((event) => (
              <Box
                key={event.seq}
                pl={event.parent ? 'md' : 0}
                style={event.parent ? { borderLeft: '2px solid var(--mantine-color-grape-4)' } : undefined}
              >
                {event.parent && event.kind !== 'note' && (
                  <Text size="10px" c="grape" fw={600} mb={2}>
                    subagent
                  </Text>
                )}
                <EventRow runId={selected ?? ''} event={event} results={results} />
              </Box>
            ))}
            {live && newest && (
              <Group gap={6}>
                <Loader size={12} />
                <Text size="xs" c="dimmed">
                  Running…
                </Text>
              </Group>
            )}
          </Stack>
        </Box>
      </Stack>
    </Drawer>
  );
}
