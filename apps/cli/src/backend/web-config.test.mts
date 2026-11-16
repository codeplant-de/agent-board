import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeDataKey, generateDataKey } from '@agent-board/shared';
import { checkBoardUrl, parseWebConfig } from './web-config.mts';
import { DATA_KEY } from '../__tests__/helpers/fakes.mts';

const ENV = { AGENT_BOARD_TOKEN: 't', AGENT_BOARD_DATA_KEY: encodeDataKey(DATA_KEY) };

test('the config needs a URL, https away from localhost, the token and the data key', () => {
  assert.deepEqual(parseWebConfig({ url: 'https://board.example/' }, ENV), {
    url: 'https://board.example',
    token: 't',
    dataKey: DATA_KEY,
  });
  assert.equal(parseWebConfig({ url: 'http://localhost:4000' }, ENV).url, 'http://localhost:4000');
  assert.throws(() => parseWebConfig({ url: 'http://board.example' }, ENV), /https/);
  assert.throws(() => parseWebConfig({ url: 'https://board.example' }, {}), /AGENT_BOARD_TOKEN/);
  assert.throws(() => parseWebConfig({}, ENV), /url/);
});

test('a missing or malformed data key is refused with a pointer to Settings, never echoing the key', () => {
  const url = { url: 'https://board.example' };
  assert.throws(
    () => parseWebConfig(url, { AGENT_BOARD_TOKEN: 't' }),
    /AGENT_BOARD_DATA_KEY \(copy it from the board's Settings page, then run "board init"\)/,
  );
  const secret = `${encodeDataKey(generateDataKey())}-damaged`;
  assert.throws(
    () => parseWebConfig(url, { AGENT_BOARD_TOKEN: 't', AGENT_BOARD_DATA_KEY: secret }),
    (error: unknown) =>
      error instanceof Error && /not a data key/.test(error.message) && !error.message.includes(secret.slice(5)),
  );
  assert.throws(
    () => parseWebConfig(url, { AGENT_BOARD_TOKEN: 't', AGENT_BOARD_DATA_KEY: 'abk1_short' }),
    /not a data key/,
  );
});

test('a board URL with whitespace anywhere is refused', () => {
  assert.equal(checkBoardUrl('https://board.example.com/'), 'https://board.example.com');
  for (const url of [
    'https://board.example.com ',
    ' https://board.example.com',
    'https://board example.com',
    'https://board.example.com/a b',
  ])
    assert.throws(() => checkBoardUrl(url), /http\(s\) URL/, JSON.stringify(url));
});
