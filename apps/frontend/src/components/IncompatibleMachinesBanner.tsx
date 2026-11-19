import { Alert, Anchor, Code } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { incompatibleMachines } from '../lib/clientStatus';
import { POLL_MS, useTRPC } from '../lib/trpc';

/** Tells you when a machine that works for you runs a CLI the board no longer accepts, which stops its tasks. */
export function IncompatibleMachinesBanner() {
  const trpc = useTRPC();
  const machines = useQuery({ ...trpc.machines.list.queryOptions(), refetchInterval: POLL_MS });
  const stuck = incompatibleMachines(machines.data ?? []);
  if (stuck.length === 0) return null;
  return (
    <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="A machine needs a CLI update" mb="md">
      The board no longer accepts the CLI on {stuck.map((m) => m.shown).join(', ')}, so{' '}
      {stuck.length === 1 ? 'it starts' : 'they start'} no tasks. Run <Code>board self-update</Code> there. See{' '}
      <Anchor component={Link} to="/settings/machines">
        Settings
      </Anchor>
      .
    </Alert>
  );
}
