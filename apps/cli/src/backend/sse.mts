// The board's event stream (`/api/machine/events`) as the listener and a worker's change watch read it.
export interface SseEvent {
  event: string;
  data: string;
}

// Server-sent events as they arrive in chunks: calls `onEvent` for each complete event, whatever the chunk boundaries.
export function createSseParser(onEvent: (event: SseEvent) => void): { push: (chunk: string) => void } {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const line = (text: string): void => {
    if (text === '') {
      if (event !== '' || data.length > 0) onEvent({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const raw = colon === -1 ? '' : text.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk) {
      buffer += chunk;
      // A trailing CR may be the first half of a CRLF; it waits for the next chunk.
      const held = buffer.endsWith('\r');
      const lines = (held ? buffer.slice(0, -1) : buffer).split(/\r\n|\n|\r/);
      buffer = (lines.pop() ?? '') + (held ? '\r' : '');
      lines.forEach(line);
    },
  };
}
