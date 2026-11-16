import type { ComboboxItem, ComboboxItemGroup } from '@mantine/core';
import { RECENT_MS } from './clientStatus';
import type { Machine } from './opening';
import { ago } from './time';

export interface DirectoryChoice {
  /** Encodes machine and path together, so the same path on two machines stays two options. */
  value: string;
  machine: string;
  path: string;
}

export interface DirectoryChoices {
  groups: ComboboxItemGroup<ComboboxItem>[];
  choices: DirectoryChoice[];
  /** The shown names of the machines whose list could not be read. */
  unreadable: string[];
}

const seenAt = ({ lastSeenAt }: Machine): number => (lastSeenAt === null ? -Infinity : new Date(lastSeenAt).getTime());

function groupLabel(machine: Machine, now: number): string {
  if (machine.lastSeenAt === null) return `${machine.shown} · never seen`;
  return now - seenAt(machine) < RECENT_MS ? machine.shown : `${machine.shown} · last seen ${ago(machine.lastSeenAt)}`;
}

/** The directories the New task form offers: one group per machine that has a readable list, the most recently seen first. */
export function directoryChoices(machines: readonly Machine[], now: number): DirectoryChoices {
  const listing = machines
    .filter(({ dirs }) => dirs !== null && dirs.length > 0)
    .sort((a, b) => seenAt(b) - seenAt(a) || a.shown.localeCompare(b.shown));
  const choices = listing.flatMap((machine) =>
    (machine.dirs ?? []).map((path) => ({ value: JSON.stringify([machine.name, path]), machine: machine.name, path })),
  );
  const groups = listing.map((machine) => ({
    group: groupLabel(machine, now),
    items: choices
      .filter(({ machine: name }) => name === machine.name)
      .map(({ value, path }) => ({ value, label: path })),
  }));
  return {
    groups,
    choices,
    unreadable: machines.filter(({ dirsUnreadable }) => dirsUnreadable).map(({ shown }) => shown),
  };
}
