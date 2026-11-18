import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { lanesFor } from '../lib/catalog';
import { laneOptions, type LaneOption } from '../lib/lane';
import { useTRPC } from '../lib/trpc';

/**
 * The options of a Lane select: the default lane, then the lanes the machines published (the chosen machine's, or any machine's
 * with none chosen), and `current` when none has it. The forms offer the same.
 */
export function useLaneOptions(machine: string | null | undefined, current: string | null): LaneOption[] {
  const trpc = useTRPC();
  const catalogs = useQuery(trpc.machines.catalogs.queryOptions()).data;
  return useMemo(() => laneOptions(current, lanesFor(catalogs ?? [], machine)), [catalogs, machine, current]);
}
