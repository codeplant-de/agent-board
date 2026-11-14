// One-off: seals the plain text that a board held before end-to-end encryption, for the single user who owned it. Run it with
// the admin database URL, once that user has set up their key in the browser. See "Cutover" in the README.
//
//   DATABASE_URL=postgresql://admin:...@localhost:5432/board \
//   AGENT_BOARD_DATA_KEY=abk1_... \
//   pnpm --filter @agent-board/backend reencrypt -- --owner <username> [--dry-run] [--key-file <path>]
import { decodeDataKey, deriveKeys } from '@agent-board/shared';
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ReencryptError, reencryptOwner } from './reencryptOwner';
import type { ReencryptSummary } from './reencryptOwner';

const USAGE = `usage: reencrypt --owner <username> [--dry-run] [--key-file <path>]

  DATABASE_URL           the admin database URL (not board_app)
  AGENT_BOARD_DATA_KEY   the owner's data key (abk1_...), or give --key-file
  --key-file <path>      a file (mode 600 or 400) holding the key, or a line AGENT_BOARD_DATA_KEY=abk1_..., such as
                         ~/.config/agent-board/env; the key is never taken from the command line
  --owner <username>     the user whose rows are sealed (default: BACKFILL_OWNER)
  --dry-run              do everything, print the summary, change nothing`;

const KEY_LINE = /^\s*(?:export\s+)?AGENT_BOARD_DATA_KEY\s*=\s*(["']?)(abk1_[A-Za-z0-9_-]+)\1\s*$/m;

function readKeyFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400)
    throw new ReencryptError(`${path} must be mode 600 or 400, is ${mode.toString(8)}.`);
  const content = readFileSync(path, 'utf8');
  const key = KEY_LINE.exec(content)?.[2] ?? (content.trim().startsWith('abk1_') ? content.trim() : undefined);
  if (key === undefined) throw new ReencryptError(`${path} holds no data key (abk1_...).`);
  return key;
}

/** The key comes from the environment or a private file, never from an argument, and is never printed. */
function dataKeyText(keyFile: string | undefined): string {
  const fromEnv = process.env['AGENT_BOARD_DATA_KEY'];
  if (keyFile !== undefined) {
    if (fromEnv) throw new ReencryptError('Give the key in AGENT_BOARD_DATA_KEY or in --key-file, not both.');
    return readKeyFile(keyFile);
  }
  if (!fromEnv) throw new ReencryptError('Set AGENT_BOARD_DATA_KEY or give --key-file.');
  return fromEnv;
}

function printSummary(summary: ReencryptSummary): void {
  const rows = Object.entries(summary.columns).sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(6, ...rows.map(([column]) => column.length));
  console.log(`\n${'column'.padEnd(width)}  converted  already sealed  left plain on purpose`);
  for (const [column, { converted, alreadySealed, leftPlain }] of rows)
    console.log(
      `${column.padEnd(width)}  ${String(converted).padStart(9)}  ${String(alreadySealed).padStart(14)}  ${String(leftPlain).padStart(21)}`,
    );
  console.log('');
  for (const [table, { rows: total, changed, seconds }] of Object.entries(summary.tables)) {
    const rate = seconds > 0 ? Math.round(total / seconds) : total;
    console.log(`${table}: ${total} rows read, ${changed} rewritten, ${seconds.toFixed(1)} s (${rate} rows/s)`);
  }
  for (const [what, n] of Object.entries(summary.notices)) console.log(`${n} ${what}`);
  for (const warning of summary.warnings) console.log(`WARNING ${warning}`);
  console.log(
    summary.dryRun
      ? '\nDry run: everything was checked and rolled back; nothing changed.'
      : '\nDone: committed. Next: VACUUM FULL the rewritten tables (see the runbook).',
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'key-file': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const owner = (values.owner ?? process.env['BACKFILL_OWNER'] ?? '').trim().toLowerCase();
  if (owner === '') throw new ReencryptError(`Name the owner with --owner.\n\n${USAGE}`);
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new ReencryptError('Set DATABASE_URL to the admin database URL.');
  const dataKey = decodeDataKey(dataKeyText(values['key-file']));
  const keys = await deriveKeys(dataKey, owner, { index: true });

  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'agent-board-reencrypt' });
  await client.connect();
  try {
    console.log(
      `${values['dry-run'] ? 'Dry run for' : 'Re-encrypting the board of'} "${owner}" (key id ${keys.keyId})`,
    );
    printSummary(await reencryptOwner({ client, owner, keys, dryRun: values['dry-run'], log: console.log }));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `reencrypt: ${error.message}` : error);
  process.exitCode = 1;
});
