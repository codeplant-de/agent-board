import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInstallPath, PluginError, resolvePluginRoot } from '../src/plugins.mts';
import type { PluginFiles } from '../src/plugins.mts';

const file = {
  version: 2,
  plugins: { 'pr-review@ccc': [{ scope: 'user', installPath: '/home/u/.claude/plugins/cache/ccc/pr-review/abc' }] },
};

test('the install path is read from installed_plugins.json', () => {
  assert.equal(parseInstallPath(file, 'pr-review@ccc'), '/home/u/.claude/plugins/cache/ccc/pr-review/abc');
});

test('a missing, malformed or relative entry is refused', () => {
  for (const raw of [
    null,
    'x',
    {},
    { plugins: {} },
    { plugins: { 'pr-review@ccc': [] } },
    { plugins: { 'pr-review@ccc': [{ installPath: 'rel/path' }] } },
    { plugins: { 'pr-review@ccc': 'nope' } },
  ]) {
    assert.throws(() => parseInstallPath(raw, 'pr-review@ccc'), PluginError);
  }
});

const known = {
  ccc: { source: { source: 'directory', path: '/work/ccc' } },
  other: { source: { source: 'github', repo: 'a/b' } },
};
const manifest = {
  plugins: [
    { name: 'engineering', source: './plugins/engineering' },
    { name: 'pr-review', source: './plugins/pr-review' },
  ],
};
const files = (over: Partial<PluginFiles> = {}): PluginFiles => ({
  installedPlugins: file,
  knownMarketplaces: known,
  marketplaceManifest: () => manifest,
  dirExists: () => true,
  ...over,
});

test("a plugin of a directory marketplace resolves to the marketplace's source directory", () => {
  assert.equal(resolvePluginRoot('pr-review@ccc', files()), '/work/ccc/plugins/pr-review');
});

test('the source in the manifest decides, not the plugin name', () => {
  const renamed = { plugins: [{ name: 'pr-review', source: './tools/review' }] };
  assert.equal(
    resolvePluginRoot('pr-review@ccc', files({ marketplaceManifest: () => renamed })),
    '/work/ccc/tools/review',
  );
});

test('a marketplace that is not a directory resolves to the install path', () => {
  const installed = { plugins: { 'pr-review@other': [{ installPath: '/cache/x' }] } };
  assert.equal(resolvePluginRoot('pr-review@other', files({ installedPlugins: installed })), '/cache/x');
});

test('an unreadable manifest, an unknown plugin, a missing directory or an escaping source fall back to the install path', () => {
  const cached = '/home/u/.claude/plugins/cache/ccc/pr-review/abc';
  for (const over of [
    { marketplaceManifest: () => undefined },
    { marketplaceManifest: () => ({ plugins: [{ name: 'x', source: './x' }] }) },
    { marketplaceManifest: () => ({ plugins: [{ name: 'pr-review', source: { source: 'github' } }] }) },
    { marketplaceManifest: () => ({ plugins: [{ name: 'pr-review', source: './../evil' }] }) },
    { dirExists: () => false },
    { knownMarketplaces: null },
  ]) {
    assert.equal(resolvePluginRoot('pr-review@ccc', files(over)), cached);
  }
});

test('a key without a marketplace is refused', () => {
  assert.throws(() => resolvePluginRoot('pr-review', files()), PluginError);
});
