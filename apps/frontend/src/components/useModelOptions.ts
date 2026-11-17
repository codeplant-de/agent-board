import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { modelsFor } from '../lib/catalog';
import { modelOptions, type ModelOption } from '../lib/model';
import { useTRPC } from '../lib/trpc';

export interface ModelChoices {
  options: ModelOption[];
  /** Whether `options` are the models a machine's catalogue listed, not the aliases. */
  fromCatalog: boolean;
}

/**
 * The options of a Model select: the models claude lists on `machine` (any machine's with none), else the aliases, and
 * `current` when neither has it. The New task form and the task page offer the same.
 */
export function useModelOptions(machine: string | null | undefined, current: string | null): ModelChoices {
  const trpc = useTRPC();
  const catalogs = useQuery(trpc.machines.catalogs.queryOptions()).data;
  return useMemo(() => {
    const listed = modelsFor(catalogs ?? [], machine);
    return {
      options: modelOptions(current, {
        ...(listed.length > 0 ? { offered: listed } : {}),
        known: modelsFor(catalogs ?? [], undefined),
      }),
      fromCatalog: listed.length > 0,
    };
  }, [catalogs, machine, current]);
}
