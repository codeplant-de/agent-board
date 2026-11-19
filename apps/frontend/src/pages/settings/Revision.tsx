import { Code, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../../lib/trpc';

const COMMIT = /^[0-9a-f]{7,40}$/;

/** The web build's own commit, baked in by the image build. */
const WEB_REVISION = COMMIT.test(import.meta.env.VITE_GIT_SHA ?? '') ? (import.meta.env.VITE_GIT_SHA ?? null) : null;

function RevisionCode({ revision }: { revision: string | null | undefined }) {
  if (revision === undefined) return <Code>…</Code>;
  if (revision === null) return <Code>unknown</Code>;
  return <Code title={revision}>{revision.slice(0, 7)}</Code>;
}

/** The deployed commits, for bug reports. Web and server are separate images and roll out apart, so both are shown. */
export function Revision() {
  const trpc = useTRPC();
  const server = useQuery(trpc.revision.queryOptions());
  return (
    <Text size="xs" c="dimmed" ta="center" data-testid="revision">
      Web <RevisionCode revision={WEB_REVISION} /> · Server{' '}
      <RevisionCode revision={server.isError ? null : server.data} />
    </Text>
  );
}
