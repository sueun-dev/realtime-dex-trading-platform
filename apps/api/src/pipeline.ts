import type { EngineEvent } from '@dex/shared';
import type { Projector } from '@dex/db';

export interface EventSink {
  dispatch(events: EngineEvent[]): void;
}

/**
 * Serialized command pipeline: every engine mutation runs inside a single
 * FIFO queue — the synchronous engine op, then durable projection (PGlite),
 * then WS broadcast — so persisted/broadcast event order always matches
 * engine order and DB writes never interleave.
 */
export class Pipeline {
  #q: Promise<unknown> = Promise.resolve();

  constructor(
    readonly projector: Projector,
    readonly sink: EventSink,
  ) {}

  /** Run an engine op returning [result, events]. Rejects with the op's error. */
  run<T>(fn: () => readonly [T, EngineEvent[]]): Promise<T> {
    const task = this.#q.then(async () => {
      const [result, events] = fn();
      if (events.length > 0) {
        await this.projector.applyBatch(events);
        this.sink.dispatch(events);
      }
      return result;
    });
    this.#q = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Run an engine op that only returns events. */
  exec(fn: () => EngineEvent[]): Promise<EngineEvent[]> {
    return this.run(() => {
      const events = fn();
      return [events, events] as const;
    });
  }

  /** Resolves after everything currently enqueued has been persisted. */
  async drain(): Promise<void> {
    await this.#q;
  }
}
