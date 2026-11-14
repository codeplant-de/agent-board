import {
  blindIndex,
  deriveKeys,
  generateDataKey,
  open,
  seal,
  type Binding,
  type Keys,
  type Opener,
  type Sealer,
} from '@agent-board/shared';

/** Plaintext that tests put into sealed fields: none of it may ever reach a database column. */
export const MARKERS = [
  'MARKER-title-7f3a',
  'MARKER-prompt-9c21',
  'MARKER-workdir-4be8',
  'MARKER-comment-1d05',
  'MARKER-question-6a77',
  'MARKER-answer-c3e9',
  'MARKER-message-52fb',
  'MARKER-pause-8e14',
  'MARKER-fail-a0d6',
  'MARKER-tooluse-3b92',
  'MARKER-output-e7c1',
  'MARKER-pr-5f48',
  'MARKER-head-2d97',
];

const keysByOwner = new Map<string, Promise<Keys>>();

/** One random data key per owner for the whole test file, as a real user has one per account. */
export function keysFor(owner = 'jascha'): Promise<Keys> {
  let keys = keysByOwner.get(owner);
  if (keys === undefined) {
    keys = deriveKeys(generateDataKey(), owner, { index: true });
    keysByOwner.set(owner, keys);
  }
  return keys;
}

/** Makes `owner` use this data key for the rest of the test file, as when a test seals with a key it also hands to the CLI. */
export function useDataKey(owner: string, dataKey: Uint8Array): void {
  keysByOwner.set(owner, deriveKeys(dataKey, owner, { index: true }));
}

/**
 * What a client has in hand: a way to seal and open one value under a binding, with the user's key. Everything above that
 * (which binding a field gets, what may be opened) is `@agent-board/shared`, the code the CLI and the browser run.
 */
export function sealerFor(owner = 'jascha') {
  const sealer: Sealer = async ({ field, context }, text) => seal(await keysFor(owner), field, context, text);
  const opener: Opener = async ({ field, context }, envelope) => {
    try {
      return await open(await keysFor(owner), field, context, envelope);
    } catch {
      return undefined;
    }
  };
  return {
    seal: sealer,
    open: opener,
    /** Opens under exactly this binding, or throws. */
    openStrict: async ({ field, context }: Binding, envelope: string) =>
      open(await keysFor(owner), field, context, envelope),
    blind: async (value: string) => blindIndex(await keysFor(owner), value),
    headIndex: async (sha: string) => blindIndex(await keysFor(owner), `head:${sha}`),
  };
}

export type Sealing = ReturnType<typeof sealerFor>;

export const sealed = sealerFor();
