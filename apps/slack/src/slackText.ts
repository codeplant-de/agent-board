/** Slack sends & < > in message text as entities; `&amp;` goes last so `&amp;lt;` stays literal. */
export function decodeEntities(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

const URL_START = /^(?:https?:|mailto:)/;
const SEGMENT = /<([^<>]*)>|[^<]+/g;

/**
 * Message text as plain text: mentions become `@Name`, channels `#name`, links `label (url)`, and the entities are decoded.
 * `names` maps user ids to display names; an id without one is shown as it is.
 */
export function renderSlackText(text: string, names: ReadonlyMap<string, string>): string {
  return text.replace(SEGMENT, (segment, token: string | undefined) => {
    if (token === undefined) return decodeEntities(segment);
    const [target = '', ...rest] = token.split('|');
    const label = rest.length > 0 ? decodeEntities(rest.join('|')) : '';
    if (target.startsWith('@')) {
      const id = target.slice(1);
      return `@${names.get(id) ?? (label || id)}`;
    }
    if (target.startsWith('#')) return `#${label || target.slice(1)}`;
    if (target.startsWith('!')) return label || `@${target.slice(1).split('^')[0]}`;
    if (URL_START.test(target)) {
      const url = decodeEntities(target);
      return label && label !== url.replace(/^mailto:/, '') ? `${label} (${url})` : url.replace(/^mailto:/, '');
    }
    return decodeEntities(token);
  });
}

/** The user ids a text mentions, as `<@U123>` or `<@U123|name>`. */
export function mentionedUserIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^<>]*)?>/g)].map((match) => match[1]!);
}
