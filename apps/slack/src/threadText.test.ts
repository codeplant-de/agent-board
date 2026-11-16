import { INBOX_TEXT_MAX } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import {
  composeInboxText,
  formatMessage,
  threadUserIds,
  UNREADABLE_THREAD_NOTE,
  type ThreadMessage,
} from './threadText';

const message = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  ts: '1763285400.000100',
  user: 'U1',
  text: 'hello',
  hasFiles: false,
  ...over,
});
const names = new Map([['U1', 'Ada']]);

describe('formatMessage', () => {
  it('gives name, UTC time and decoded text', () => {
    expect(formatMessage(message({ text: 'a &amp; b <@U1>' }), names)).toBe('Ada (2025-11-16 09:30 UTC): a & b @Ada');
  });

  it('falls back to the id, the bot name, and a marker for files', () => {
    expect(formatMessage(message({ user: 'U9' }), names)).toContain('U9 (');
    expect(formatMessage(message({ user: undefined, username: 'ci' }), names)).toContain('ci (');
    expect(formatMessage(message({ user: undefined }), names)).toContain('bot (');
    expect(formatMessage(message({ text: '', hasFiles: true }), names)).toMatch(/: \[file\]$/);
    expect(formatMessage(message({ text: ' ' }), names)).toMatch(/: \[no text\]$/);
  });
});

describe('threadUserIds', () => {
  it('collects authors and mentions once', () => {
    expect(threadUserIds([message({ text: '<@U2>' }), message({ user: 'U2' })])).toEqual(['U1', 'U2']);
  });
});

describe('composeInboxText', () => {
  const parts = { note: 'schedule a follow-up', permalink: 'https://x.slack.com/archives/C1/p1' };

  it('puts the note, the link and the messages in order', () => {
    expect(composeInboxText({ ...parts, lines: ['a', 'b'] })).toBe(
      'schedule a follow-up\n\nFrom a Slack thread: https://x.slack.com/archives/C1/p1\n---\na\nb',
    );
  });

  it('omits what is missing', () => {
    expect(composeInboxText({ note: '', permalink: 'https://l', lines: ['a'] })).toBe(
      'From a Slack thread: https://l\n---\na',
    );
    expect(composeInboxText({ note: 'n', permalink: null, lines: [] })).toBe('n');
  });

  it('says so when the thread could not be read', () => {
    expect(composeInboxText({ ...parts, lines: null })).toBe(
      `schedule a follow-up\n\nFrom a Slack thread: https://x.slack.com/archives/C1/p1\n${UNREADABLE_THREAD_NOTE}`,
    );
  });

  it('keeps the first and the newest messages and counts the rest', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i}${'x'.repeat(98)}`);
    const text = composeInboxText({ ...parts, lines }, 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain(lines[0]!);
    expect(text).toContain(lines[9]!);
    expect(text).not.toContain(lines[1]!);
    expect(text).toMatch(/\[… \d+ messages left out …\]/);
    expect(text.indexOf(lines[8]!)).toBeGreaterThan(text.indexOf('left out'));
  });

  it('fits the inbox limit however long a thread is', () => {
    const lines = Array.from({ length: 400 }, () => 'y'.repeat(3000));
    expect(composeInboxText({ ...parts, lines }).length).toBeLessThanOrEqual(INBOX_TEXT_MAX);
  });
});
