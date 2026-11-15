// What the CLI remembers between runs about updates, in one small JSON file of the state directory: when it last
// showed the update hint, and before when no self-update is tried again. The file is a convenience, so no failure to read or
// write it is ever an error.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord } from '@agent-board/shared';

export interface UpdateState {
  // When the update hint was last shown.
  hintShownAt(): Date | undefined;
  markHintShown(at: Date): void;
  // No self-update is tried before this time; written before an attempt, so one that is killed midway still counts.
  retryAfter(): Date | undefined;
  deferUpdateUntil(at: Date): void;
  clearDeferral(): void;
}

type Fields = { hintShownAt?: string; retryAfter?: string };

const date = (value: unknown): Date | undefined => {
  const parsed = typeof value === 'string' ? new Date(value) : undefined;
  return parsed !== undefined && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
};

export function updateStateFile(stateDir: string): string {
  return join(stateDir, 'update.json');
}

export function createUpdateState(path: string): UpdateState {
  const read = (): Fields => {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(raw)) return {};
      return {
        ...(date(raw['hintShownAt']) ? { hintShownAt: String(raw['hintShownAt']) } : {}),
        ...(date(raw['retryAfter']) ? { retryAfter: String(raw['retryAfter']) } : {}),
      };
    } catch {
      return {};
    }
  };
  const write = (fields: Fields): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(fields)}\n`);
    } catch {
      // Nothing to do: the next run shows the hint, or tries the update, again.
    }
  };
  return {
    hintShownAt: () => date(read().hintShownAt),
    markHintShown: (at) => write({ ...read(), hintShownAt: at.toISOString() }),
    retryAfter: () => date(read().retryAfter),
    deferUpdateUntil: (at) => write({ ...read(), retryAfter: at.toISOString() }),
    clearDeferral() {
      const { retryAfter: _deferred, ...rest } = read();
      write(rest);
    },
  };
}
