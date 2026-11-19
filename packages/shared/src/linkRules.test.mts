import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError, parseSealed } from './contract.mts';
import { deriveKeys, generateDataKey, open, seal } from './crypto.mts';
import {
  isLinkRulesVersion,
  linkRuleProblem,
  MAX_LINK_RULES,
  openLinkRules,
  sealLinkRules,
  type LinkRulesDocument,
} from './linkRules.mts';
import type { Opener, Sealer } from './sealing.mts';

const keys = await deriveKeys(generateDataKey(), 'jascha');
const sealer: Sealer = (binding, text) => seal(keys, binding.field, binding.context, text);
const opener: Opener = async (binding, value) => {
  try {
    return await open(keys, binding.field, binding.context, value);
  } catch {
    return undefined;
  }
};

const STORY = { pattern: 'sc-(\\d+)', url: 'https://app.shortcut.com/acme/story/$1' };

test('the document is sealed under its version and opens only as that version', async () => {
  const document: LinkRulesDocument = { version: 2, rules: [STORY, { ...STORY, pattern: 'SC#(\\d+)', flags: 'i' }] };
  const wire = await sealLinkRules(sealer, document);
  assert.doesNotThrow(() => parseSealed(wire, 'links', 'links'));
  assert.deepEqual(await openLinkRules(opener, 2, wire), document);
  assert.equal(await openLinkRules(opener, 3, wire), undefined, 'relabelled as a newer version');
  assert.equal(await openLinkRules(opener, 1, wire), undefined, 'relabelled as an older version');
  assert.equal(await openLinkRules(opener, 0, wire), undefined);
});

test('an empty list of rules is a document', async () => {
  const wire = await sealLinkRules(sealer, { version: 1, rules: [] });
  assert.deepEqual(await openLinkRules(opener, 1, wire), { version: 1, rules: [] });
});

test('a rule that does not compile, has a bad URL or is too long is refused', () => {
  assert.match(linkRuleProblem({ pattern: '(', url: STORY.url }) ?? '', /regular expression/);
  assert.match(linkRuleProblem({ pattern: '', url: STORY.url }) ?? '', /empty/);
  assert.match(linkRuleProblem({ pattern: 'a'.repeat(301), url: STORY.url }) ?? '', /300/);
  assert.match(linkRuleProblem({ pattern: 'a', url: 'javascript:alert(1)' }) ?? '', /https/);
  assert.match(linkRuleProblem({ pattern: 'a', url: '/story/$1' }) ?? '', /https/);
  assert.match(linkRuleProblem({ pattern: 'a', url: `https://acme.test/${'a'.repeat(1000)}` }) ?? '', /1000/);
  assert.match(linkRuleProblem({ pattern: 'a', url: STORY.url, flags: 'g' as 'i' }) ?? '', /flag/);
  assert.equal(linkRuleProblem(STORY), undefined);
  assert.equal(linkRuleProblem({ pattern: 'a', url: 'http://acme.test/$&' }), undefined);
});

test('sealing refuses a bad version, too many rules and a rule that does not work', async () => {
  await assert.rejects(sealLinkRules(sealer, { version: 0, rules: [] }), ContractError);
  await assert.rejects(
    sealLinkRules(sealer, { version: 1, rules: Array(MAX_LINK_RULES + 1).fill(STORY) }),
    ContractError,
  );
  await assert.rejects(sealLinkRules(sealer, { version: 1, rules: [{ pattern: '(', url: STORY.url }] }), ContractError);
  assert.equal(isLinkRulesVersion(1.5), false);
  assert.equal(isLinkRulesVersion('1'), false);
});

test('a document that says another version inside, or holds a rule that does not work, is unreadable', async () => {
  const seal1 = (json: unknown) => sealer({ field: 'links', context: 'links:v3' }, JSON.stringify(json));
  assert.equal(await openLinkRules(opener, 3, await seal1({ version: 2, rules: [] })), undefined);
  assert.equal(
    await openLinkRules(opener, 3, await seal1({ version: 3, rules: [{ pattern: '(', url: STORY.url }] })),
    undefined,
  );
  assert.equal(
    await openLinkRules(opener, 3, await seal1({ version: 3, rules: [{ ...STORY, url: 'ftp://x' }] })),
    undefined,
  );
  assert.equal(
    await openLinkRules(opener, 3, await seal1({ version: 3, rules: [{ ...STORY, flags: 'gi' }] })),
    undefined,
  );
  assert.equal(await openLinkRules(opener, 3, await seal1({ version: 3, rules: 'none' })), undefined);
  assert.equal(await openLinkRules(opener, 3, await seal1({ version: 3, rules: [1] })), undefined);
  assert.equal(
    await openLinkRules(opener, 3, await sealer({ field: 'links', context: 'links:v3' }, 'not json')),
    undefined,
  );
});
