import { describe, expect, it } from 'vitest';
import { INBOX_TEXT_MAX } from '@agent-board/shared';
import { parseCommand } from './commands';

describe('parseCommand', () => {
  it('shows the usage for no text and for help', () => {
    expect(parseCommand('')).toEqual({ kind: 'help' });
    expect(parseCommand('   ')).toEqual({ kind: 'help' });
    expect(parseCommand('Help')).toEqual({ kind: 'help' });
  });

  it('knows link and unlink in any case', () => {
    expect(parseCommand('link')).toEqual({ kind: 'link' });
    expect(parseCommand(' UNLINK ')).toEqual({ kind: 'unlink' });
  });

  it('proposes a task from anything else, trimmed', () => {
    expect(parseCommand('  review PR 42\nand the docs ')).toEqual({ kind: 'add', text: 'review PR 42\nand the docs' });
  });

  it('takes a subcommand only as the whole text', () => {
    expect(parseCommand('link the docs')).toEqual({ kind: 'add', text: 'link the docs' });
    expect(parseCommand('help me')).toEqual({ kind: 'add', text: 'help me' });
  });

  it('decodes the entities Slack puts in for & < >, and nothing else', () => {
    expect(parseCommand('fix &lt;Foo&gt; &amp; Bar')).toEqual({ kind: 'add', text: 'fix <Foo> & Bar' });
    expect(parseCommand('show &amp;lt; as is')).toEqual({ kind: 'add', text: 'show &lt; as is' });
    expect(parseCommand('&quot;x&quot;')).toEqual({ kind: 'add', text: '&quot;x&quot;' });
  });

  it('refuses text over the limit', () => {
    expect(parseCommand('a'.repeat(INBOX_TEXT_MAX))).toMatchObject({ kind: 'add' });
    expect(parseCommand('a'.repeat(INBOX_TEXT_MAX + 1))).toEqual({ kind: 'too-long', length: INBOX_TEXT_MAX + 1 });
  });
});
