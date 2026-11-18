import { Center, Paper, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { AccountDeletedContext } from './AccountDeletedContext';

function AccountDeletedScreen() {
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack>
          <Title order={3}>Your account and its data are deleted</Title>
          <Text size="sm">
            This page no longer talks to the board. You can close it. If you reload it, you get the sign-in page, or on
            a board without login the setup screen for a new, empty board.
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}

/**
 * Sits above everything that polls the board. Once the account is deleted it replaces the app with a screen that makes no
 * request: any later write would create the account again, and a later read would only show an empty board.
 */
export function AccountDeletedProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [deleted, setDeleted] = useState(false);
  const markDeleted = useCallback(() => setDeleted(true), []);
  // After the commit that unmounted the app, so no observer is left to refetch what is dropped.
  useEffect(() => {
    if (!deleted) return;
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [deleted, queryClient]);
  if (deleted) return <AccountDeletedScreen />;
  return <AccountDeletedContext.Provider value={markDeleted}>{children}</AccountDeletedContext.Provider>;
}
