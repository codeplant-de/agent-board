import { Button, Group, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/trpc';
import { KeyError } from './kdf';

interface Props {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onClose: () => void;
  /** A rejection is shown in the modal, which stays open; the caller unmounts it on success. */
  onSubmit: (passphrase: string) => Promise<void>;
}

/** Asks for the passphrase again: the browser keeps no raw key, so what needs one must open it from the passphrase. */
export function PassphraseModal({ title, description, confirmLabel, onClose, onSubmit }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (passphrase === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(passphrase);
    } catch (err) {
      setError(err instanceof KeyError ? err.message : errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={title}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack>
          <Text size="sm">{description}</Text>
          <PasswordInput
            label="Passphrase"
            value={passphrase}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
            error={error}
            autoComplete="current-password"
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={passphrase === ''} loading={busy}>
              {confirmLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
