import { describe, expect, it } from 'vitest';
import type { Machine } from './opening';
import { unlistedMachine } from './workingDirectories';

const laptop = (dirs: string[] | null): Machine => ({ name: 'laptop', shown: 'Laptop', dirs }) as Machine;

describe('unlistedMachine', () => {
  const task = (workdir: string | null, machine: string | null = 'laptop') => ({ machine, workdir });

  it('is silent for a listed directory and for anything below one, by whole segments', () => {
    const machines = [laptop(['/work/app'])];
    expect(unlistedMachine(task('/work/app'), machines)).toBeUndefined();
    expect(unlistedMachine(task('/work/app/'), machines)).toBeUndefined();
    expect(unlistedMachine(task('/work/app/.claude/worktrees/x'), machines)).toBeUndefined();
  });

  it('names the machine when the directory is neither listed nor below a listed one', () => {
    const machines = [laptop(['/work/app'])];
    expect(unlistedMachine(task('/work/application'), machines)).toBe('Laptop');
    expect(unlistedMachine(task('/work'), machines)).toBe('Laptop');
  });

  it('is silent without a directory, a machine, or a readable list to compare with', () => {
    expect(unlistedMachine(task(null), [laptop(['/a'])])).toBeUndefined();
    expect(unlistedMachine(task('/x', null), [laptop(['/a'])])).toBeUndefined();
    expect(unlistedMachine(task('/x'), [laptop(null)])).toBeUndefined();
    expect(unlistedMachine(task('/x'), [laptop([])])).toBeUndefined();
    expect(unlistedMachine(task('/x', 'other'), [laptop(['/a'])])).toBeUndefined();
  });
});
