import type { Keys } from '@agent-board/shared';
import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage, useTRPC } from '../lib/trpc';
import { PRODUCTION_KDF, KeyError, type KdfParams } from './kdf';
import { replacePassphrase, unlockKeys, type Secret, type StoredKey } from './keySlots';
import { PASSPHRASE_ADVICE, passphraseProblem, samePassphrase } from './passphrase';

interface Props {
  owner: string;
  onUnlocked: (keys: Keys) => Promise<void>;
  kdf?: KdfParams;
}

const messageOf = (error: unknown): string => (error instanceof KeyError ? error.message : errorMessage(error));

function PassphraseForm({
  owner,
  stored,
  onUnlocked,
}: {
  owner: string;
  stored: StoredKey;
  onUnlocked: Props['onUnlocked'];
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (passphrase === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlocked(await unlockKeys({ owner, stored, secret: { kind: 'passphrase', passphrase } }));
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <PasswordInput
          label="Passphrase"
          value={passphrase}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
          error={error}
          autoComplete="current-password"
          data-autofocus
        />
        <Button type="submit" disabled={passphrase === ''} loading={busy}>
          Unlock
        </Button>
      </Stack>
    </form>
  );
}

function RecoveryForm({
  owner,
  stored,
  kdf,
  onUnlocked,
}: {
  owner: string;
  stored: StoredKey;
  kdf: KdfParams;
  onUnlocked: Props['onUnlocked'];
}) {
  const trpc = useTRPC();
  const replaceSlots = useMutation(trpc.keys.replaceSlots.mutationOptions());
  const [recoveryKey, setRecoveryKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passphrase === '' ? null : passphraseProblem(passphrase);
  const mismatch = again !== '' && !samePassphrase(again, passphrase);
  const ready = recoveryKey.trim() !== '' && passphrase !== '' && problem === null && samePassphrase(again, passphrase);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const secret: Secret = { kind: 'recovery', recoveryKey };
      const { keys, slots } = await replacePassphrase({ owner, stored, secret, newPassphrase: passphrase, kdf });
      await replaceSlots.mutateAsync({ keyId: stored.keyId, slots });
      await onUnlocked(keys);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Text size="sm">
          Enter your recovery key and choose a new passphrase. The recovery key stays valid, so keep it.
        </Text>
        <TextInput
          label="Recovery key"
          value={recoveryKey}
          onChange={(event) => setRecoveryKey(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          data-autofocus
        />
        <Text size="sm" c="dimmed">
          {PASSPHRASE_ADVICE}
        </Text>
        <PasswordInput
          label="New passphrase"
          value={passphrase}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
          error={problem}
          autoComplete="new-password"
        />
        <PasswordInput
          label="New passphrase again"
          value={again}
          onChange={(event) => setAgain(event.currentTarget.value)}
          error={mismatch ? 'The passphrases differ.' : null}
          autoComplete="new-password"
        />
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <Button type="submit" disabled={!ready} loading={busy}>
          Unlock with the recovery key
        </Button>
      </Stack>
    </form>
  );
}

/** The board has a key but this browser has none usable: the passphrase opens it, or the recovery key and a new passphrase. */
export function UnlockScreen({ owner, onUnlocked, kdf = PRODUCTION_KDF }: Props) {
  const trpc = useTRPC();
  const stored = useQuery(trpc.keys.get.queryOptions());
  const [recovering, setRecovering] = useState(false);
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack>
          <Group gap="xs">
            <IconLock size={22} />
            <Title order={3}>Unlock the board</Title>
          </Group>
          {stored.isLoading && <Loader size="sm" />}
          {stored.error && <Text c="red">{errorMessage(stored.error)}</Text>}
          {stored.data === null && <Text c="red">No key is set up for this account.</Text>}
          {stored.data &&
            (recovering ? (
              <RecoveryForm owner={owner} stored={stored.data} kdf={kdf} onUnlocked={onUnlocked} />
            ) : (
              <PassphraseForm owner={owner} stored={stored.data} onUnlocked={onUnlocked} />
            ))}
          {stored.data && (
            <Anchor component="button" type="button" size="sm" onClick={() => setRecovering(!recovering)}>
              {recovering ? 'Use my passphrase' : 'Use my recovery key'}
            </Anchor>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
