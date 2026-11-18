import { useCallback, useState } from 'react';
import { CANCELLED, failureMessage, isCancelled } from './failure';

/**
 * One try at a sign-in step that shows it is busy. A failure is the text for the card to show; a dismissed passkey prompt is a
 * plain note, not a failure. A second try while one runs does nothing.
 */
export function useAttempt() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useCallback(
    async (attempt: () => Promise<void>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await attempt();
      } catch (err) {
        if (isCancelled(err)) setNote(CANCELLED);
        else setError(failureMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );
  return { busy, error, note, run };
}
