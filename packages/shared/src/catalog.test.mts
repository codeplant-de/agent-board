import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalogProblem,
  cleanCatalogText,
  isSafeSkillName,
  machineCatalogJson,
  parseMachineCatalog,
} from './catalog.mts';
import type { MachineCatalog } from './catalog.mts';

const CATALOG: MachineCatalog = {
  claude: '2.1.326',
  models: [
    { value: 'opus', label: 'Opus', description: 'The big one' },
    { value: 'haiku', label: 'Haiku' },
  ],
  skills: [{ name: 'review-pr', description: 'Review a pull request', argumentHint: '<number>' }, { name: 'docx' }],
  dirs: { '/work/app': [{ name: 'deploy', description: 'Ship it' }] },
};

test('skill names are letters, digits and _ . : -, start alphanumeric and are at most 100 characters', () => {
  for (const good of ['review-pr', 'a', 'plugin:docx', 'v1.2_x', 'x'.repeat(100)])
    assert.ok(isSafeSkillName(good), good);
  for (const bad of ['', '-x', '.x', ':x', 'a b', 'claude.ai Notion:search (MCP)', 'a/b', 'a\nb', 'x'.repeat(101)])
    assert.ok(!isSafeSkillName(bad), bad);
});

test('cleaning strips control characters, collapses whitespace and cuts to the limit', () => {
  assert.equal(cleanCatalogText('  one \n two\t\tthree\u0007four ', 100), 'one two three four');
  assert.equal(cleanCatalogText('abcdef', 3), 'abc');
  assert.equal(cleanCatalogText('ab  cd', 3), 'ab');
  assert.equal(cleanCatalogText('😀😀😀', 2), '😀😀');
  assert.equal(cleanCatalogText(' \n\u0001 ', 10), '');
});

test('the document has its known fields in a fixed order, whatever the input has more', () => {
  assert.equal(
    machineCatalogJson(CATALOG),
    '{"claude":"2.1.326","models":[{"value":"opus","label":"Opus","description":"The big one"},{"value":"haiku","label":"Haiku"}],' +
      '"skills":[{"name":"review-pr","description":"Review a pull request","argumentHint":"<number>"},{"name":"docx"}],' +
      '"dirs":{"/work/app":[{"name":"deploy","description":"Ship it"}]}}',
  );
  const noisy = { ...CATALOG, skills: [{ argumentHint: 'x', name: 'a', extra: 1 }] };
  assert.equal(
    machineCatalogJson(noisy),
    machineCatalogJson({ ...CATALOG, skills: [{ name: 'a', argumentHint: 'x' }] }),
  );
  assert.equal(machineCatalogJson({ models: [], skills: [], dirs: {} }), '{"models":[],"skills":[],"dirs":{}}');
});

test('a catalogue document parses back to the catalogue', () => {
  assert.deepEqual(parseMachineCatalog(JSON.parse(machineCatalogJson(CATALOG))), CATALOG);
  assert.deepEqual(parseMachineCatalog({}), { models: [], skills: [], dirs: {} });
});

test('a document of another shape or over a cap is unreadable', () => {
  for (const bad of [
    null,
    [],
    'x',
    { models: 'opus' },
    { skills: {} },
    { dirs: [] },
    { dirs: { '/a': 'x' } },
    { models: Array.from({ length: 51 }, () => ({ value: 'opus' })) },
    { skills: Array.from({ length: 501 }, (_, i) => ({ name: `s${i}` })) },
    { dirs: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`/d${i}`, [{ name: 'a' }]])) },
    { dirs: { '/a': Array.from({ length: 201 }, (_, i) => ({ name: `s${i}` })) } },
  ])
    assert.equal(parseMachineCatalog(bad), undefined, JSON.stringify(bad).slice(0, 60));
  assert.equal(
    parseMachineCatalog({ skills: Array.from({ length: 500 }, (_, i) => ({ name: `s${i}` })) })?.skills.length,
    500,
  );
});

test('an entry or text of the wrong shape is dropped, not the document', () => {
  const parsed = parseMachineCatalog({
    claude: 'x'.repeat(65),
    models: [
      { value: 'default', label: 'Default' },
      { value: 'bad value' },
      'x',
      { value: 'opus', label: '', description: 'a\nb' },
    ],
    skills: [
      { name: 'ok', description: 5, argumentHint: ' padded ' },
      { name: 'claude.ai Notion:x (MCP)' },
      { name: 7 },
      null,
      { name: 'long', description: 'x'.repeat(201), argumentHint: 'x'.repeat(101) },
    ],
    dirs: { relative: [{ name: 'a' }], '/empty': [], '/a': [{ name: 'b' }, { description: 'nameless' }] },
    later: 'keys are ignored',
  });
  assert.deepEqual(parsed, {
    models: [
      { value: 'default', label: 'Default' },
      { value: 'opus', label: 'opus' },
    ],
    skills: [{ name: 'ok' }, { name: 'long' }],
    dirs: { '/a': [{ name: 'b' }] },
  });
});

test('a catalogue the board would not take has a problem, one it takes has none', () => {
  assert.equal(catalogProblem(CATALOG), undefined);
  assert.match(
    catalogProblem({ ...CATALOG, models: Array.from({ length: 51 }, () => CATALOG.models[0]!) }) ?? '',
    /50 models/,
  );
  assert.match(catalogProblem({ ...CATALOG, skills: [{ name: 'has space' }] }) ?? '', /not of its shape/);
  assert.match(
    catalogProblem({ ...CATALOG, skills: [{ name: 'a', description: 'two\nlines' }] }) ?? '',
    /not of its shape/,
  );
  assert.match(catalogProblem({ ...CATALOG, dirs: { relative: [{ name: 'a' }] } }) ?? '', /not of its shape/);
  assert.match(catalogProblem({ ...CATALOG, dirs: { '/a': [] } }) ?? '', /not of its shape/);
  assert.match(catalogProblem({ ...CATALOG, claude: '' }) ?? '', /not of its shape/);
});
