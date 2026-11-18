import { agentHash } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { agentOnMachine, machineAgents, viewSharedAgent } from './sharedAgents';

const REVIEWER = {
  description: 'Reviews',
  tools: ['Read', 'Grep'],
  allowedTools: ['Read', 'Bash(git log *)'],
  env: ['GITHUB_TOKEN'],
  version: '1.2.0',
};

describe('viewSharedAgent', () => {
  it('reads a definition with the flags the CLI prints and the hash the machines report', async () => {
    const view = await viewSharedAgent('reviewer', REVIEWER);
    expect(view).toMatchObject({
      name: 'reviewer',
      description: 'Reviews',
      version: '1.2.0',
      prompt: null,
      tools: ['Read', 'Grep'],
      disallowedTools: [],
      mcpServers: [],
      problems: [],
      hash: await agentHash(REVIEWER),
      flags: {
        broad: [{ rule: 'Read', reason: 'reads every file the deny list does not name' }],
        secrets: ['GITHUB_TOKEN'],
        emptyDenyList: true,
        deadTools: ['Bash'],
      },
    });
    expect(JSON.parse(view.definition)).toEqual(REVIEWER);
  });

  it('shows a key of the wrong shape empty and names it, as a machine refuses it', async () => {
    const view = await viewSharedAgent('odd', { description: 3, tools: 'Read', env: ['A', 1] });
    expect(view).toMatchObject({ description: null, tools: [], env: [] });
    expect(view.problems).toEqual([
      'tools is not a list of strings',
      'env is not a list of strings',
      'description is not text',
      'description is missing',
      'tools is empty',
    ]);
  });
});

describe('agentOnMachine', () => {
  const [laptop, old, desktop] = machineAgents([
    {
      name: 'laptop',
      catalog: {
        models: [],
        skills: [],
        dirs: {},
        agents: { version: 2, hashes: { reviewer: 'a'.repeat(64) }, replaced: ['reviewer'] },
      },
    },
    { name: 'old', catalog: { models: [], skills: [], dirs: {} } },
    {
      name: 'desktop',
      catalog: { models: [], skills: [], dirs: {}, agents: { version: 1, hashes: {}, replaced: [] } },
    },
  ]);

  it('tells the board definition, another one, none, and a machine that does not report', () => {
    expect(laptop).toMatchObject({ machine: 'laptop', reports: true, version: 2, replaced: ['reviewer'] });
    expect(agentOnMachine(laptop!, { name: 'reviewer', hash: 'a'.repeat(64) })).toEqual({ kind: 'same' });
    expect(agentOnMachine(laptop!, { name: 'reviewer', hash: 'b'.repeat(64) })).toEqual({
      kind: 'other',
      hash: 'a'.repeat(64),
    });
    expect(agentOnMachine(desktop!, { name: 'reviewer', hash: 'a'.repeat(64) })).toEqual({ kind: 'missing' });
    expect(old).toMatchObject({ reports: false, version: null });
    expect(agentOnMachine(old!, { name: 'reviewer', hash: 'a'.repeat(64) })).toEqual({ kind: 'silent' });
  });
});
