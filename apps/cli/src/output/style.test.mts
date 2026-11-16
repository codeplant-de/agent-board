import assert from 'node:assert/strict';
import tty from 'node:tty';
import { test } from 'node:test';
import { createStyle, wantsColor } from './style.mts';

test('a style without colour leaves the text as it is, and one with colour wraps it in bold or dim', () => {
  const plain = createStyle(false);
  assert.equal(plain.bold('todo'), 'todo');
  assert.equal(plain.dim('hint'), 'hint');
  const coloured = createStyle(true);
  assert.equal(coloured.bold('todo'), '\x1b[1mtodo\x1b[22m');
  assert.equal(coloured.dim('hint'), '\x1b[2mhint\x1b[22m');
});

test('colour is wanted only on a terminal whose environment does not turn it off', () => {
  // A terminal stream as node builds it: its own colour detection reads the environment.
  const terminal = {
    hasColors: tty.WriteStream.prototype.hasColors,
    getColorDepth: tty.WriteStream.prototype.getColorDepth,
  };
  assert.equal(wantsColor(terminal, { TERM: 'xterm-256color' }), true);
  for (const env of [{ NO_COLOR: '1' }, { TERM: 'dumb' }, { FORCE_COLOR: '0' }, { NODE_DISABLE_COLORS: '1' }])
    assert.equal(wantsColor(terminal, { TERM: 'xterm-256color', ...env }), false, JSON.stringify(env));
  assert.equal(wantsColor({}, { FORCE_COLOR: '1' }), false, 'a pipe has no colour method');
});
