import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { Passkeys } from '../../auth/Passkeys';
import { useAuthConfig } from '../../auth/useAuthConfig';
import { useSignOut } from '../../auth/useSignOut';
import { YourData } from '../../components/YourData';

function Session() {
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  if (signOut === null) return null;
  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Session</Title>
          <Text size="sm" c="dimmed">
            Signing out also locks the board on this device, so the passphrase is asked for again.
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void signOut().finally(() => setBusy(false));
            }}
          >
            Sign out
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function AccountSettings() {
  const config = useAuthConfig();
  return (
    <Stack>
      {config.data?.login === true && config.data.passkeys && <Passkeys />}
      <Session />
      <YourData />
    </Stack>
  );
}
