import { EventEmitter } from 'node:events';

export const CHANGES_DEBOUNCE_MS = 500;

/**
 * Tells the open machine streams that an owner's tasks or schedules changed, so their workers look again.
 * In process, which is enough for one replica; Postgres LISTEN/NOTIFY would replace it with more.
 */
export class Changes {
  private readonly emitter = new EventEmitter();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly debounceMs: number = CHANGES_DEBOUNCE_MS) {
    // One listener per open stream.
    this.emitter.setMaxListeners(0);
  }

  /** Call after the write has committed. A burst of calls for one owner gives one event, `debounceMs` after the last. */
  notify(owner: string): void {
    clearTimeout(this.timers.get(owner));
    this.timers.set(
      owner,
      setTimeout(() => {
        this.timers.delete(owner);
        this.emitter.emit(this.eventName(owner));
      }, this.debounceMs).unref(),
    );
  }

  /** Returns the function that stops listening. */
  subscribe(owner: string, listener: () => void): () => void {
    const name = this.eventName(owner);
    this.emitter.on(name, listener);
    return () => {
      this.emitter.off(name, listener);
    };
  }

  close(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  // Prefixed so that an owner named `error` is not the emitter's error event.
  private eventName(owner: string): string {
    return `owner:${owner}`;
  }
}
