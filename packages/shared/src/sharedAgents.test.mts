import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError, parseVersionAgentsVersion, parseWireSetAgents, parseWireSharedAgents } from './contract.mts';
import { deriveKeys, generateDataKey, open, seal } from './crypto.mts';
import type { Opener, Sealer } from './sealing.mts';
import { agentHash, agentHashInput, openSharedAgents, sealSharedAgents, sharedAgentsJson } from './sharedAgents.mts';

const keys = await deriveKeys(generateDataKey(), 'jascha');
const sealer: Sealer = (binding, text) => seal(keys, binding.field, binding.context, text);
const opener: Opener = async (binding, value) => {
  try {
    return await open(keys, binding.field, binding.context, value);
  } catch {
    return undefined;
  }
};

const REVIEWER = { description: 'Reviews', tools: ['Read'], allowedTools: ['Read'] };

test('the document is sealed under its version and opens only as that version', async () => {
  const document = { version: 2, agents: { writer: REVIEWER, reviewer: REVIEWER } };
  const wire = await sealSharedAgents(sealer, document);
  assert.deepEqual(await openSharedAgents(opener, 2, wire), document);
  assert.equal(await openSharedAgents(opener, 3, wire), undefined, 'relabelled as a newer version');
  assert.equal(await openSharedAgents(opener, 1, wire), undefined, 'relabelled as an older version');
  assert.equal(
    sharedAgentsJson(document),
    sharedAgentsJson({ version: 2, agents: { reviewer: REVIEWER, writer: REVIEWER } }),
  );
});

test('a document with a name that is not an agent name, a non-mapping entry or a bad version is refused', async () => {
  await assert.rejects(sealSharedAgents(sealer, { version: 1, agents: { 'Bad Name': REVIEWER } }), ContractError);
  await assert.rejects(
    sealSharedAgents(sealer, { version: 1, agents: { ok: [] as unknown as Record<string, unknown> } }),
    ContractError,
  );
  await assert.rejects(sealSharedAgents(sealer, { version: 0, agents: {} }), ContractError);
  // A document that says another version inside than the one it is bound to.
  const wire = await sealer(
    { field: 'agents.shared', context: 'agents:v3' },
    JSON.stringify({ version: 2, agents: {} }),
  );
  assert.equal(await openSharedAgents(opener, 3, wire), undefined);
});

test('the hash covers what a run may do, not version or source, and a missing list is an empty one', async () => {
  const base = await agentHash(REVIEWER);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await agentHash({ ...REVIEWER, version: '2.0', source: 'board' }), base);
  assert.equal(await agentHash({ ...REVIEWER, disallowedTools: [], env: [], mcpServers: [] }), base);
  assert.equal(await agentHash({ allowedTools: ['Read'], tools: ['Read'], description: 'Reviews' }), base, 'key order');
  assert.notEqual(await agentHash({ ...REVIEWER, allowedTools: ['Read', 'Bash'] }), base);
  assert.equal(
    agentHashInput(REVIEWER),
    '{"allowedTools":["Read"],"description":"Reviews","disallowedTools":[],"env":[],"mcpServers":[],"tools":["Read"]}',
  );
});

test('the wire: set-agents needs version = expectedVersion + 1, get-agents and the version answer are checked', async () => {
  const document = await sealSharedAgents(sealer, { version: 1, agents: {} });
  assert.deepEqual(parseWireSetAgents({ document, version: 1, expectedVersion: 0 }), {
    document,
    version: 1,
    expectedVersion: 0,
  });
  assert.throws(() => parseWireSetAgents({ document, version: 2, expectedVersion: 0 }), /expectedVersion \+ 1/);
  assert.throws(() => parseWireSetAgents({ document: 'plain', version: 1, expectedVersion: 0 }), /encrypted/);
  assert.throws(() => parseWireSetAgents({ document, version: 1, expectedVersion: 0, extra: 1 }), ContractError);
  assert.equal(parseWireSharedAgents(null), null);
  assert.deepEqual(parseWireSharedAgents({ version: 1, document }), { version: 1, document });
  assert.throws(() => parseWireSharedAgents({ version: 0, document }), /positive integer/);
  assert.equal(parseVersionAgentsVersion({ agentsVersion: 4 }), 4);
  assert.equal(parseVersionAgentsVersion({ agentsVersion: '4' }), null);
  assert.equal(parseVersionAgentsVersion({}), null);
});
