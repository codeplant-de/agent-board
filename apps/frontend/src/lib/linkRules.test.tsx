import type { LinkRule } from '@agent-board/shared';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../components/Markdown';
import { LinkRulesContext } from './linkRulesContext';

const STORY: LinkRule = { pattern: 'sc-(\\d+)', url: 'https://app.shortcut.com/acme/story/$1' };

function html(markdown: string, rules: LinkRule[]): HTMLElement {
  const { container } = render(
    <LinkRulesContext.Provider value={rules}>
      <Markdown>{markdown}</Markdown>
    </LinkRulesContext.Provider>,
  );
  return container;
}

const links = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('a'), (a) => [a.textContent, a.getAttribute('href')]);

describe('link rules in markdown', () => {
  it('links the text a rule matches, in a new tab, and keeps the text around it', () => {
    const container = html('Fixed in sc-72195 today.', [STORY]);
    expect(links(container)).toEqual([['sc-72195', 'https://app.shortcut.com/acme/story/72195']]);
    const a = container.querySelector('a');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('p')).toHaveTextContent('Fixed in sc-72195 today.');
  });

  it('links every match, in headings, lists, emphasis and tables too', () => {
    const container = html('# sc-1\n\n- sc-2 and *sc-3*\n\n| a |\n|---|\n| sc-4 |\n\nsc-5 sc-6', [STORY]);
    expect(links(container).map(([text]) => text)).toEqual(['sc-1', 'sc-2', 'sc-3', 'sc-4', 'sc-5', 'sc-6']);
  });

  it('leaves code, code spans, existing links, autolinks and HTML alone', () => {
    const container = html(
      [
        '`sc-1`',
        '',
        '```',
        'sc-2',
        '```',
        '',
        '[sc-3](https://example.com/a)',
        '',
        'https://example.com/sc-4',
        '',
        '<div>sc-5</div>',
        '',
        '[ref]: https://example.com/b "sc-6"',
        '',
        '[sc-7][ref]',
      ].join('\n'),
      [STORY],
    );
    expect(links(container)).toEqual([
      ['sc-3', 'https://example.com/a'],
      ['https://example.com/sc-4', 'https://example.com/sc-4'],
      ['sc-7', 'https://example.com/b'],
    ]);
  });

  it('lets the earliest match win across rules, and the earlier rule on the same start', () => {
    const rules: LinkRule[] = [
      { pattern: 'sc-(\\d+)', url: 'https://a.test/$1' },
      { pattern: 'c-(\\d+)', url: 'https://b.test/$1' },
      { pattern: 'sc-\\d+', url: 'https://c.test/x' },
    ];
    expect(links(html('sc-12', rules))).toEqual([['sc-12', 'https://a.test/12']]);
    expect(links(html('x-1 c-3 sc-4', [rules[1]!, rules[0]!]))).toEqual([
      ['c-3', 'https://b.test/3'],
      ['sc-4', 'https://a.test/4'],
    ]);
  });

  it('does not link inside a match another rule made, and continues after it', () => {
    const rules: LinkRule[] = [
      { pattern: 'PR#\\d+', url: 'https://a.test/pr' },
      { pattern: '#(\\d+)', url: 'https://b.test/$1' },
    ];
    expect(links(html('PR#12 and #34', rules))).toEqual([
      ['PR#12', 'https://a.test/pr'],
      ['#34', 'https://b.test/34'],
    ]);
  });

  it('fills $1..$9, $<name>, $& and $$, encoding what was captured', () => {
    const rules: LinkRule[] = [
      { pattern: '(?<project>[a-z]+)/(\\d+)', url: 'https://t.test/$<project>/$2?m=$&&c=$$&n=$3' },
    ];
    expect(links(html('see app/12', rules))).toEqual([['app/12', 'https://t.test/app/12?m=app%2F12&c=$&n=$3']]);
    // A group that did not take part fills in as nothing.
    expect(links(html('a', [{ pattern: '(a)(b)?', url: 'https://t.test/$1/$2' }]))).toEqual([
      ['a', 'https://t.test/a/'],
    ]);
    const encoded = links(html('go q:a/b?c', [{ pattern: 'q:(\\S+)', url: 'https://t.test/?q=$1' }]));
    expect(encoded).toEqual([['q:a/b?c', 'https://t.test/?q=a%2Fb%3Fc']]);
  });

  it('ignores zero-length matches', () => {
    expect(links(html('abc', [{ pattern: 'x*', url: 'https://t.test/' }]))).toEqual([]);
    expect(links(html('abxc', [{ pattern: 'x*', url: 'https://t.test/' }]))).toEqual([['x', 'https://t.test/']]);
  });

  it('leaves the text plain when the filled URL is not a usable http or https URL', () => {
    expect(links(html('sc-', [{ pattern: 'sc-(\\d*)', url: 'https://$1' }]))).toEqual([]);
    expect(links(html('sc-1', [{ pattern: 'sc-(\\d+)', url: 'javascript:alert($1)' }]))).toEqual([]);
    expect(links(html('sc-1', [{ pattern: 'sc-(\\d+)', url: 'ftp://x.test/$1' }]))).toEqual([]);
    // Another position of the same rule still links when its own URL is valid.
    expect(links(html('a-x a-1', [{ pattern: 'a-(\\w)', url: 'https://t.test/$1' }]))).toEqual([
      ['a-x', 'https://t.test/x'],
      ['a-1', 'https://t.test/1'],
    ]);
  });

  it('cannot be turned into a script link by what a match captures', () => {
    const container = html('go javascript:alert(1)', [{ pattern: '(javascript:\\S+)', url: 'https://t.test/?u=$1' }]);
    expect(links(container)).toEqual([['javascript:alert(1)', 'https://t.test/?u=javascript%3Aalert(1)']]);
  });

  it('honours the case flag and skips rules that do not compile', () => {
    expect(links(html('SC-9', [STORY]))).toEqual([]);
    expect(links(html('SC-9', [{ ...STORY, flags: 'i' }]))).toEqual([
      ['SC-9', 'https://app.shortcut.com/acme/story/9'],
    ]);
    expect(links(html('sc-9', [{ pattern: '(', url: 'https://t.test/' }, STORY]))).toHaveLength(1);
  });

  it('changes nothing without rules', () => {
    expect(links(html('sc-1', []))).toEqual([]);
  });
});
