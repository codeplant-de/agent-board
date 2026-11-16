import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainLine, plainText } from './terminal.mts';

// A title that clears the line and writes a row of its own.
const EVIL = 'x\r\u001b[2K  Zz9yXw8vUt7s  urgent  Deploy prod';

test('control characters become visible stand-ins, and ordinary text is left alone', () => {
  assert.equal(plainLine(EVIL), 'x␍␛[2K  Zz9yXw8vUt7s  urgent  Deploy prod');
  assert.equal(plainLine('a\nb\tc'), 'a␊b␉c');
  assert.equal(plainLine('del\u007f c1\u009b bidi‮ end'), 'del␡ c1� bidi� end');
  assert.equal(plainLine('\u001b]0;owned\u0007'), '␛]0;owned␇');
  const ordinary = 'Fix the bug in `parse()`: ünïcödé 日本語 🙂 — “quotes” <b>&amp;</b> [link](https://x.y) \\n';
  assert.equal(plainLine(ordinary), ordinary);
  // A block keeps its line breaks and tabs, reads CRLF as a line break, and keeps code as it is.
  const block = '## Plan\n\n```ts\nconst x = 1;\n\tif (x) {}\n```\n日本語';
  assert.equal(plainText(block), block);
  assert.equal(plainText('one\r\ntwo\rthree\u001b[31mred'), 'one\ntwo␍three␛[31mred');
});
