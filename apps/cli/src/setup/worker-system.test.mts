import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkerSystem } from './worker-system.mts';

test('macOS runs a worker as a detached process and Linux as a systemd unit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-worker-system-test-'));
  process.env['AGENT_BOARD_RUN_DIR'] = dir;
  try {
    for (const [platform, expected] of [
      ['darwin', /^DRY spawn detached /],
      ['linux', /^DRY systemd-run /],
    ] as const) {
      const lines: string[] = [];
      await createWorkerSystem({ dryRun: true, print: (line) => void lines.push(line), platform }).startWorker(
        'Ab3dEf9x',
      );
      assert.match(lines[0] ?? '', expected, platform);
    }
  } finally {
    delete process.env['AGENT_BOARD_RUN_DIR'];
    rmSync(dir, { recursive: true });
  }
});
