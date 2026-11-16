import { describe, expect, it } from 'vitest';
import { decodeEntities, mentionedUserIds, renderSlackText } from './slackText';

const names = new Map([['U1', 'Ada']]);

describe('decodeEntities', () => {
  it('decodes & < > and leaves a double-escaped entity literal', () => {
    expect(decodeEntities('a &lt;b&gt; &amp; c &amp;lt;')).toBe('a <b> & c &lt;');
  });
});

describe('renderSlackText', () => {
  it('turns mentions into names and keeps an unknown id', () => {
    expect(renderSlackText('hi <@U1> and <@U2>', names)).toBe('hi @Ada and @U2');
    expect(renderSlackText('<@U2|bob>', names)).toBe('@bob');
  });

  it('writes channels, links and special mentions', () => {
    expect(renderSlackText('<#C1|dev> <https://x.test/a?b=1&amp;c=2|the docs> <https://y.test> <!here>', names)).toBe(
      '#dev the docs (https://x.test/a?b=1&c=2) https://y.test @here',
    );
    expect(renderSlackText('<mailto:a@b.test|a@b.test>', names)).toBe('a@b.test');
    expect(renderSlackText('<!subteam^S1|@oncall> <!date^1|Jan 1>', names)).toBe('@oncall Jan 1');
  });

  it('decodes entities outside tokens', () => {
    expect(renderSlackText('1 &lt; 2 &amp;&amp; 3 &gt; 2', names)).toBe('1 < 2 && 3 > 2');
  });
});

describe('mentionedUserIds', () => {
  it('lists mentioned users', () => {
    expect(mentionedUserIds('<@U1> <@U2|x> <#C1|y>')).toEqual(['U1', 'U2']);
  });
});
