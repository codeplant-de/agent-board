import { parseKeySetup } from '@agent-board/shared';
import { Alert, Button, Checkbox, Code, Divider, Group, Paper, Progress, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useKeys } from '../crypto/KeyContext';
import { buildExport, downloadBlob, exportFileName, exportRowCount, type ExportProgress } from '../lib/boardExport';
import { readBoardPrefs } from '../lib/boardPrefs';
import { errorMessage, useRawTRPC, useRawTRPCClient } from '../lib/trpc';
import { DeleteAccountModal } from './DeleteAccountModal';
import { ExportFileChooser, type ChosenExport } from './ExportFileChooser';
import { ExportFileSummary } from './ExportFileSummary';
import { ImportRunView } from './ImportRunView';
import { useImportRun } from './useImportRun';

type ExportState =
  | { status: 'idle' }
  | { status: 'running'; progress: ExportProgress }
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

function useSummary() {
  const raw = useRawTRPC();
  return useQuery({ ...raw.account.summary.queryOptions(), staleTime: 0 });
}

function ExportSection() {
  const client = useRawTRPCClient();
  const keys = useKeys();
  const summary = useSummary();
  const [includeTranscripts, setIncludeTranscripts] = useState(true);
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const [controller, setController] = useState<AbortController | null>(null);

  const start = async () => {
    if (keys === null) return;
    const own = new AbortController();
    setController(own);
    setState({ status: 'running', progress: { rows: 0, total: 0 } });
    try {
      // The total is read when the export starts, so a board that changed since the page loaded still shows true progress.
      const fresh = await summary.refetch();
      if (fresh.data === undefined) throw fresh.error;
      const stored = await client.keys.get.query(undefined, { signal: own.signal });
      if (stored === null) throw new Error('This board has no key to export.');
      const keySetup = parseKeySetup(stored);
      if (keySetup.keyId !== keys.keyId)
        throw new Error('The board’s key is not the one this browser uses. Reload the page.');
      const total = exportRowCount(fresh.data, includeTranscripts);
      const blob = await buildExport({
        owner: keys.owner,
        keySetup,
        includeTranscripts,
        prefs: readBoardPrefs(),
        total,
        signal: own.signal,
        fetchPage: (table, cursor, signal) => client.account.export.query({ table, cursor }, { signal }),
        onProgress: (progress) => setState({ status: 'running', progress }),
      });
      downloadBlob(blob, exportFileName(keys.owner, new Date()));
      setState({ status: 'done' });
    } catch (error) {
      setState(own.signal.aborted ? { status: 'cancelled' } : { status: 'failed', message: errorMessage(error) });
    } finally {
      setController(null);
    }
  };

  const running = state.status === 'running';
  const progress = state.status === 'running' ? state.progress : null;
  return (
    <Stack gap="xs">
      <div>
        <Title order={6}>Export</Title>
        <Text size="sm" c="dimmed">
          One file with your whole board as the server stores it, still encrypted, the wrapped key slots and the machine
          token hashes, and the settings of this browser. Keep it as safe as a backup of the database: it opens nothing
          without your passphrase or recovery key.
        </Text>
      </div>
      <Checkbox
        label="Include transcripts"
        description="They are most of the size of a board."
        checked={includeTranscripts}
        disabled={running}
        onChange={(event) => setIncludeTranscripts(event.currentTarget.checked)}
      />
      <Group>
        <Button onClick={() => void start()} loading={running} disabled={keys === null || summary.data === undefined}>
          Download export
        </Button>
        {running && (
          <Button variant="default" onClick={() => controller?.abort()}>
            Cancel
          </Button>
        )}
      </Group>
      {progress !== null && (
        <Stack gap={4}>
          <Progress
            value={progress.total === 0 ? 0 : Math.min(100, (progress.rows / progress.total) * 100)}
            aria-label="Export progress"
          />
          <Text size="sm">
            {progress.rows} of {progress.total} rows
          </Text>
        </Stack>
      )}
      {state.status === 'done' && <Text size="sm">The export was downloaded.</Text>}
      {state.status === 'cancelled' && <Text size="sm">The export was cancelled. Nothing was downloaded.</Text>}
      {state.status === 'failed' && (
        <Text size="sm" c="red">
          The export failed: {state.message}
        </Text>
      )}
    </Stack>
  );
}

function ImportSection() {
  const keys = useKeys();
  const queryClient = useQueryClient();
  const { run, start, cancel, reset } = useImportRun();
  const [chosen, setChosen] = useState<ChosenExport | null>(null);
  const running = run.status === 'running';
  const otherKey = chosen !== null && keys !== null && chosen.header.keyId !== keys.keyId;

  const importFile = async () => {
    if (chosen === null || keys === null) return;
    await start(chosen.file, keys);
    await queryClient.invalidateQueries();
  };

  return (
    <Stack gap="xs">
      <div>
        <Title order={6}>Import</Title>
        <Text size="sm" c="dimmed">
          Adds the rows of an export to this board. Rows that are already here are skipped, so importing the same file
          twice does no harm.
        </Text>
      </div>
      <ExportFileChooser
        disabled={running}
        onChange={(next) => {
          reset();
          setChosen(next);
        }}
      />
      {chosen !== null && keys !== null && (
        <>
          <ExportFileSummary header={chosen.header} owner={keys.owner} />
          {otherKey && (
            <Alert color="red" title="This file uses another key">
              <Text size="sm">
                This board uses another key than the one that encrypted the file (key id{' '}
                <Code>{chosen.header.keyId}</Code>
                ). The file can only be imported into an account that has no key yet, from the setup screen.
              </Text>
            </Alert>
          )}
          {!otherKey && run.status !== 'running' && run.status !== 'done' && (
            <Group>
              <Button onClick={() => void importFile()}>Import this file</Button>
            </Group>
          )}
        </>
      )}
      {chosen !== null && keys !== null && (
        <ImportRunView run={run} onCancel={cancel} owner={keys.owner} fileOwner={chosen.header.owner} />
      )}
    </Stack>
  );
}

function DeleteSection() {
  const keys = useKeys();
  const summary = useSummary();
  const [asking, setAsking] = useState(false);
  return (
    <Paper withBorder p="md" style={{ borderColor: 'var(--mantine-color-red-6)' }}>
      <Stack gap="xs">
        <div>
          <Title order={5} c="red">
            Delete account
          </Title>
          <Text size="sm" c="dimmed">
            Deletes everything the board holds for you: tasks, schedules, notes, machines, transcripts and your key
            slots. Export your data first.
          </Text>
        </div>
        <Group>
          <Button
            color="red"
            variant="outline"
            disabled={keys === null || summary.data === undefined}
            onClick={() => setAsking(true)}
          >
            Delete account…
          </Button>
        </Group>
        {asking && keys !== null && summary.data !== undefined && (
          <DeleteAccountModal username={keys.owner} summary={summary.data} onClose={() => setAsking(false)} />
        )}
      </Stack>
    </Paper>
  );
}

export function YourData() {
  return (
    <>
      <Paper withBorder p="md">
        <Stack>
          <div>
            <Title order={5}>Your data</Title>
            <Text size="sm" c="dimmed">
              Take your board with you, or put an export back.
            </Text>
          </div>
          <ExportSection />
          <Divider />
          <ImportSection />
        </Stack>
      </Paper>
      <DeleteSection />
    </>
  );
}
