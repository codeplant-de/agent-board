import type { Timers } from '../../backend/event-stream.mts';

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A clock that only moves when the test says so.
export class FakeClock implements Timers {
  time = 0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  now = (): number => this.time;
  after = (ms: number, fn: () => void): (() => void) => {
    const timer = { at: this.time + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  // Runs everything that falls due in the next `ms`, in order, letting promises settle after each.
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.fn();
      await settle();
    }
    this.time = end;
  }
}

// An event stream the test writes to.
export function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}
