import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slackText } from '../src/notify.mts';

test('Slack markup in the title and the text is escaped', () => {
  const text = slackText(
    { title: 'a <!channel> & <b|c>', url: 'https://x.example/t' },
    'see <https://evil.example|link> &amp; <!here>',
  );
  assert.equal(
    text,
    '<https://x.example/t|a &lt;!channel&gt; &amp; &lt;b|c&gt;>\nsee &lt;https://evil.example|link&gt; &amp;amp; &lt;!here&gt;',
  );
});

test('a url cannot end the link early', () => {
  const text = slackText({ title: 't', url: 'https://x.example/a|b>c<d e' }, 'x');
  assert.equal(text.split('\n')[0], '<https://x.example/a%7Cb%3Ec%3Cd%20e|t>');
});
