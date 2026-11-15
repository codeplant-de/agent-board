import { Alert, Group, Loader, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { errorMessage } from '../lib/trpc';

interface QueryLike {
  data: unknown;
  error: unknown;
  isLoading: boolean;
}

/**
 * What a query shows besides its data: a loader on the first load, and its error. A failed poll keeps the data it had, so the
 * error then says the view is stale instead of replacing it. A list that is loading or failed is not empty: show its empty text
 * only once `query.data` is there.
 */
export function QueryStatus({ query, what }: { query: QueryLike; what: string }) {
  if (query.isLoading) {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading {what}…
        </Text>
      </Group>
    );
  }
  if (!query.error) return null;
  const stale = query.data !== undefined;
  return (
    <Alert color="red" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
      <Text size="sm">
        {stale ? `Could not refresh ${what}; showing what loaded last` : `Could not load ${what}`}:{' '}
        {errorMessage(query.error)}
      </Text>
    </Alert>
  );
}
