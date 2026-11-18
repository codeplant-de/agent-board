import type { ExportHeader } from '@agent-board/shared';
import { Alert, Code, List, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

interface Props {
  header: ExportHeader;
  /** The signed-in username, whose key will seal what is imported. */
  owner: string;
}

/** What a file is, and what importing it means; shown before anything is sent. */
export function ExportFileSummary({ header, owner }: Props) {
  return (
    <Stack gap="xs">
      <List size="sm" spacing={2}>
        <List.Item>Exported {new Date(header.exportedAt).toLocaleString()}</List.Item>
        <List.Item>
          By user <Code>{header.owner}</Code>
        </List.Item>
        <List.Item>
          Key id <Code>{header.keyId}</Code>
        </List.Item>
        <List.Item>{header.transcripts ? 'With transcripts' : 'Without transcripts'}</List.Item>
      </List>
      {header.owner !== owner && (
        <Text size="sm">
          This file was made under another username. Its content is encrypted again for <Code>{owner}</Code> in this
          browser before it is sent.
        </Text>
      )}
      <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Before you import">
        <Stack gap={4}>
          <Text size="sm">Only import a file you exported yourself.</Text>
          <Text size="sm">
            The machines in the file keep their tokens, so they work against this board once their <Code>web.json</Code>{' '}
            points here.
          </Text>
          <Text size="sm">Tasks in Todo will start on those machines.</Text>
        </Stack>
      </Alert>
    </Stack>
  );
}
