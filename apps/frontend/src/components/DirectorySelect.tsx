import { Code, Select, type SelectProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { errorMessage } from '../lib/trpc';
import type { DirectoryChoicesState } from './useDirectoryChoices';

function directoryDescription(noList: boolean, unreadable: string[]): ReactNode {
  const unreadableNote =
    unreadable.length === 0
      ? null
      : `The directory ${unreadable.length === 1 ? 'list' : 'lists'} of ${unreadable.join(', ')} could not be read.`;
  if (noList)
    return (
      <>
        No machine has listed a directory yet. Run <Code>board dirs add</Code> in a checkout.
        {unreadableNote !== null && ` ${unreadableNote}`}
      </>
    );
  return unreadableNote ?? undefined;
}

interface Props extends Pick<SelectProps, 'label' | 'comboboxProps' | 'size' | 'placeholder'> {
  directories: DirectoryChoicesState;
  /** The `value` of a `DirectoryChoice`; null is no directory. */
  value: string | null;
  onChange: (value: string | null) => void;
}

/** A search over the directories the machines listed, grouped by machine; clearing it chooses no directory. */
export function DirectorySelect({
  directories,
  value,
  onChange,
  placeholder = 'Default directory of whichever machine takes it',
  ...props
}: Props) {
  const { groups, choices, unreadable, machines } = directories;
  return (
    <Select
      {...props}
      placeholder={machines.isPending ? 'Loading machines…' : placeholder}
      searchable
      clearable
      allowDeselect={false}
      data={groups}
      value={value}
      onChange={onChange}
      disabled={machines.isPending || machines.isError || choices.length === 0}
      error={machines.isError ? errorMessage(machines.error) : undefined}
      description={directoryDescription(choices.length === 0 && !machines.isPending, unreadable)}
    />
  );
}
