import type { KeySetup, Keys } from '@agent-board/shared';

/**
 * The slots the board stores, read as the key this browser is using: the owner and key id are the browser's, not the ones the
 * board reports, so a key that unwraps is shown or re-wrapped only when it is the one in use.
 */
export function asHeld(stored: KeySetup, keys: Keys): KeySetup {
  return { ...stored, keyId: keys.keyId };
}
